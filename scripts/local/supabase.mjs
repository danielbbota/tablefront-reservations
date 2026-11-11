// =============================================================================
// A stand-in for Supabase, for running the whole app on a laptop with no
// Supabase project at all: `npm run dev:local`.
//
// It is the real schema (every file in supabase/migrations, applied to an
// in-process Postgres via tests/helpers/pglite.ts) behind just enough of the
// two HTTP APIs the app talks to:
//
//   /rest/v1/...   the PostgREST subset this codebase uses: select / insert /
//                  update / delete / upsert / rpc, the eq neq gt gte lt lte is
//                  in like ilike filters (and not.*), order, limit, exact
//                  counts, object responses. Every request runs as the Postgres
//                  role its key or session maps to, so RLS, grants and
//                  triggers behave exactly as in production.
//   /auth/v1/...   password sign-in, session refresh, current user, sign-out
//                  and the admin user endpoints the onboarding API calls.
//
// Data lives in memory and is reseeded on every start. Nothing here is used
// in production or by the test suites: it exists to look at the product.
// =============================================================================
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { migratedDatabase } from '../../tests/helpers/pglite.ts';

const JWT_SECRET = 'local-demo-only-not-a-secret';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function readJwt(token) {
  const [head, body, sig] = String(token ?? '').split('.');
  if (!head || !body || !sig) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** The two project keys, like the ones in a Supabase project's API settings. */
export const ANON_KEY = signJwt({ role: 'anon', iss: 'local-demo' });
export const SERVICE_ROLE_KEY = signJwt({ role: 'service_role', iss: 'local-demo' });

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw httpError(400, 'PGRST100', `invalid identifier "${name}"`);
  return `"${name}"`;
};

function httpError(status, code, message, details = null) {
  return Object.assign(new Error(message), { http: { status, body: { code, message, details, hint: null } } });
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };

/** "eq.5", "not.in.(a,b)", "is.null" … → SQL condition on `column`. */
function condition(column, expr, params) {
  let negate = false;
  let rest = expr;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  const op = dot === -1 ? rest : rest.slice(0, dot);
  const value = dot === -1 ? '' : rest.slice(dot + 1);
  let sql;
  if (op === 'is') {
    const literal = { null: 'null', true: 'true', false: 'false' }[value];
    if (!literal) throw httpError(400, 'PGRST100', `unsupported is.${value}`);
    sql = `${ident(column)} is ${literal}`;
  } else if (op === 'in') {
    const items = value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).filter((v) => v !== '');
    if (!items.length) sql = 'false';
    else {
      const marks = items.map((item) => {
        params.push(item);
        return `$${params.length}`;
      });
      sql = `${ident(column)} in (${marks.join(',')})`;
    }
  } else if (OPS[op]) {
    params.push(op === 'like' || op === 'ilike' ? value.replaceAll('*', '%') : value);
    sql = `${ident(column)} ${OPS[op]} $${params.length}`;
  } else {
    throw httpError(400, 'PGRST100', `unsupported filter "${expr}"`);
  }
  return negate ? `not (${sql})` : sql;
}

function whereClause(query, params) {
  const parts = [];
  for (const [key, value] of query.entries()) {
    if (!RESERVED.has(key)) parts.push(condition(key, value, params));
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function columnList(query) {
  const raw = (query.get('select') ?? '*').replace(/\s/g, '');
  if (raw === '*' || raw === '') return '*';
  return raw.split(',').map(ident).join(', ');
}

function orderClause(query) {
  const raw = query.get('order');
  if (!raw) return '';
  const terms = raw.split(',').map((term) => {
    const [column, ...mods] = term.split('.');
    let sql = ident(column);
    if (mods.includes('desc')) sql += ' desc';
    if (mods.includes('nullsfirst')) sql += ' nulls first';
    if (mods.includes('nullslast')) sql += ' nulls last';
    return sql;
  });
  return ` order by ${terms.join(', ')}`;
}

function limitClause(query) {
  const limit = query.get('limit');
  const offset = query.get('offset');
  return (limit && /^\d+$/.test(limit) ? ` limit ${limit}` : '') + (offset && /^\d+$/.test(offset) ? ` offset ${offset}` : '');
}

const pgValue = (value) =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : value;

export async function startLocalSupabase({ port = 54321, seed } = {}) {
  const db = await migratedDatabase();
  await db.exec(`alter table auth.users add column password text, add column created_at timestamptz not null default now();`);
  if (seed) await seed(db);

  // One connection: requests take turns, each as its own Postgres role.
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function asCaller(caller, fn) {
    const role = caller.role === 'service_role' ? 'service_role' : caller.sub ? 'authenticated' : 'anon';
    const claims = JSON.stringify(caller.sub ? { sub: caller.sub, role } : { role }).replaceAll("'", "''");
    await db.exec(`set request.jwt.claims = '${claims}'; set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role; reset request.jwt.claims;');
    }
  }

  function callerOf(req) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const claims = readJwt(bearer) ?? readJwt(req.headers.apikey);
    if (!claims) return { role: 'anon' };
    if (claims.role === 'service_role') return { role: 'service_role' };
    return claims.sub ? { role: 'authenticated', sub: claims.sub } : { role: 'anon' };
  }

  const userJson = (u) => ({
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.created_at,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: u.created_at,
    updated_at: u.created_at,
  });

  function session(user) {
    const now = Math.floor(Date.now() / 1000);
    const expires = now + 3600;
    return {
      access_token: signJwt({ sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email, iat: now, exp: expires }),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expires,
      refresh_token: signJwt({ sub: user.id, typ: 'refresh', jti: randomUUID() }),
      user: userJson(user),
    };
  }

  const findUser = async (column, value) =>
    (await db.query(`select id, email, password, created_at::text from auth.users where ${column} = $1`, [value])).rows[0];

  async function auth(req, url, body) {
    const path = url.pathname.replace('/auth/v1', '');
    const invalid = { status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };

    if (path === '/token' && url.searchParams.get('grant_type') === 'password') {
      const user = await findUser('lower(email)', String(body.email ?? '').toLowerCase());
      if (!user || !user.password || user.password !== body.password) return invalid;
      return { status: 200, body: session(user) };
    }
    if (path === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const claims = readJwt(body.refresh_token);
      const user = claims?.typ === 'refresh' ? await findUser('id', claims.sub) : null;
      if (!user) return { status: 400, body: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
      return { status: 200, body: session(user) };
    }
    if (path === '/user' && req.method === 'GET') {
      const caller = callerOf(req);
      const user = caller.sub ? await findUser('id', caller.sub) : null;
      if (!user) return { status: 401, body: { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' } };
      return { status: 200, body: userJson(user) };
    }
    if (path === '/logout') return { status: 204, body: null };

    if (path.startsWith('/admin/users')) {
      if (callerOf(req).role !== 'service_role') return { status: 403, body: { code: 403, error_code: 'not_admin', msg: 'User not allowed' } };
      const id = path.split('/')[3];
      if (req.method === 'POST') {
        if (await findUser('lower(email)', String(body.email ?? '').toLowerCase())) {
          return { status: 422, body: { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' } };
        }
        const created = (
          await db.query(`insert into auth.users (email, password) values ($1, $2) returning id, email, created_at::text`, [body.email, body.password ?? null])
        ).rows[0];
        return { status: 200, body: userJson(created) };
      }
      if (req.method === 'DELETE' && id) {
        await db.query(`delete from auth.users where id = $1`, [id]);
        return { status: 200, body: {} };
      }
      if (req.method === 'GET') {
        const { rows } = await db.query(`select id, email, created_at::text from auth.users order by created_at`);
        return { status: 200, body: { users: rows.map(userJson), aud: 'authenticated' } };
      }
    }
    return { status: 404, body: { code: 404, msg: `auth: ${req.method} ${path} is not implemented locally` } };
  }

  async function rest(req, url, body) {
    const segments = url.pathname.replace('/rest/v1/', '').split('/');
    const query = url.searchParams;
    const prefer = String(req.headers.prefer ?? '');
    const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    const params = [];
    let sql;
    let countSql = null;

    if (segments[0] === 'rpc') {
      const args = Object.entries(body ?? {});
      const list = args.map(([name, value]) => {
        params.push(pgValue(value));
        return `${ident(name)} => $${params.length}`;
      });
      sql = `select coalesce(json_agg(r), '[]')::text as body from ${ident(segments[1])}(${list.join(', ')}) r`;
    } else {
      const table = ident(segments[0]);
      const returning = columnList(query);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const where = whereClause(query, params);
        if (prefer.includes('count=exact')) countSql = { text: `select count(*)::int as n from ${table}${where}`, params: [...params] };
        sql =
          req.method === 'HEAD'
            ? null
            : `select coalesce(json_agg(r), '[]')::text as body from (select ${returning} from ${table}${where}${orderClause(query)}${limitClause(query)}) r`;
      } else if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body ?? {}];
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const tuples = rows.map((row) => {
          const marks = columns.map((column) => {
            if (!(column in row)) return 'default';
            params.push(pgValue(row[column]));
            return `$${params.length}`;
          });
          return `(${marks.join(', ')})`;
        });
        let conflict = '';
        if (prefer.includes('resolution=merge-duplicates')) {
          const target = (query.get('on_conflict') ?? 'id').split(',').map(ident).join(', ');
          const sets = columns.map((column) => `${ident(column)} = excluded.${ident(column)}`).join(', ');
          conflict = ` on conflict (${target}) do update set ${sets}`;
        }
        const insert = columns.length
          ? `insert into ${table} (${columns.map(ident).join(', ')}) values ${tuples.join(', ')}${conflict}`
          : `insert into ${table} default values`;
        sql = `with w as (${insert} returning *) select coalesce(json_agg(r), '[]')::text as body from (select ${returning} from w) r`;
      } else if (req.method === 'PATCH') {
        const sets = Object.entries(body ?? {}).map(([column, value]) => {
          params.push(pgValue(value));
          return `${ident(column)} = $${params.length}`;
        });
        if (!sets.length) throw httpError(400, 'PGRST100', 'empty update');
        const where = whereClause(query, params);
        sql = `with w as (update ${table} set ${sets.join(', ')}${where} returning *) select coalesce(json_agg(r), '[]')::text as body from (select ${returning} from w) r`;
      } else if (req.method === 'DELETE') {
        const where = whereClause(query, params);
        sql = `with w as (delete from ${table}${where} returning *) select coalesce(json_agg(r), '[]')::text as body from (select ${returning} from w) r`;
      } else {
        throw httpError(405, 'PGRST117', `unsupported method ${req.method}`);
      }
    }

    return asCaller(callerOf(req), async () => {
      const headers = {};
      if (countSql) {
        const n = (await db.query(countSql.text, countSql.params)).rows[0].n;
        headers['Content-Range'] = `*/${n}`;
      }
      if (!sql) return { status: 200, body: null, headers };

      const rows = JSON.parse((await db.query(sql, params)).rows[0].body);
      const wantsRows = req.method === 'GET' || segments[0] === 'rpc' || prefer.includes('return=representation');
      if (!wantsRows) return { status: req.method === 'POST' ? 201 : 204, body: null, headers };
      if (wantsObject) {
        if (rows.length !== 1) {
          throw httpError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`);
        }
        return { status: req.method === 'POST' && segments[0] !== 'rpc' ? 201 : 200, body: rows[0], headers };
      }
      return { status: req.method === 'POST' && segments[0] !== 'rpc' ? 201 : 200, body: rows, headers };
    });
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Range',
  };

  const extraRoutes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    try {
      for (const route of extraRoutes) {
        const handled = await route(req, url, res, db);
        if (handled) return;
      }
      let out;
      if (url.pathname.startsWith('/auth/v1/')) out = await exclusive(() => auth(req, url, body ?? {}));
      else if (url.pathname.startsWith('/rest/v1/')) out = await exclusive(() => rest(req, url, body));
      else out = { status: 404, body: { message: 'not found' } };

      res.writeHead(out.status, { 'Content-Type': 'application/json', ...CORS, ...(out.headers ?? {}) });
      res.end(out.body === null || req.method === 'HEAD' ? undefined : JSON.stringify(out.body));
    } catch (err) {
      const http = err.http ?? {
        // A Postgres error, shaped the way PostgREST reports it.
        status: err.code === '42501' ? 403 : err.code === '23505' || err.code === '23503' ? 409 : 400,
        body: { code: err.code ?? 'XX000', message: err.message, details: err.detail ?? null, hint: err.hint ?? null },
      };
      if (!err.http && !err.code) console.error('[local-supabase]', req.method, url.pathname, err);
      res.writeHead(http.status, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(http.body));
    }
  });

  // port 0 = any free port (used by tests).
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    db,
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    /** Serve something else from the same port (the widget demo page). */
    route: (handler) => extraRoutes.push(handler),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
