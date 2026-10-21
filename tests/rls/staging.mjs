// Shared helpers for the RLS tenant-isolation tests.
// Everything here talks ONLY to the STAGING Supabase project, through the
// logged-in Supabase CLI (Management API). No database password and no
// service-role key are needed or stored on disk.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Project ref of tablefront-reservations-staging. Override with RLS_TEST_PROJECT_REF. */
export const STAGING_REF = process.env.RLS_TEST_PROJECT_REF ?? 'zbzrbodraecmihzdvvot';
export const STAGING_URL = `https://${STAGING_REF}.supabase.co`;

/** Parse the first JSON value (object or array) found in CLI output. */
function parseJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* not pure JSON */ }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i !== -1);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const closer = t[start] === '{' ? '}' : ']';
  const end = t.lastIndexOf(closer);
  if (end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function runCli(args, { allowFail = false } = {}) {
  const res = spawnSync('supabase', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`supabase CLI not runnable: ${res.error.message}`);
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const json = parseJson(res.stdout ?? '') ?? parseJson(out);
  if (res.status !== 0 && !allowFail) {
    const msg = json?.error?.message ?? out.trim();
    const err = new Error(msg);
    err.code = json?.error?.code;
    throw err;
  }
  return { status: res.status, json, raw: out };
}

/**
 * Hard guard: refuse to run unless the target ref is an ACTIVE project whose
 * name marks it as staging. Also refuses if that same ref is what .env.local
 * points at AND the name does not say staging (belt and braces).
 */
export function assertStagingOnly() {
  const { json } = runCli(['projects', 'list', '-o', 'json']);
  const projects = Array.isArray(json?.projects) ? json.projects : Array.isArray(json) ? json : [];
  const project = projects.find((p) => p.ref === STAGING_REF || p.id === STAGING_REF);
  if (!project) {
    throw new Error(`Refusing to run: project ref ${STAGING_REF} is not visible to the logged-in Supabase CLI account.`);
  }
  if (!/staging/i.test(project.name ?? '')) {
    throw new Error(`Refusing to run: project ${STAGING_REF} is named "${project.name}", which does not contain "staging".`);
  }
  const envLocal = resolve(process.cwd(), '.env.local');
  if (existsSync(envLocal)) {
    const m = readFileSync(envLocal, 'utf8').match(/NEXT_PUBLIC_SUPABASE_URL=\s*https:\/\/([a-z0-9]+)\.supabase\.co/);
    if (m && m[1] !== STAGING_REF) {
      // Expected: .env.local points at a different (live) project. Nothing to do.
    }
  }
  return { ref: STAGING_REF, name: project.name, status: project.status };
}

/**
 * Run SQL on staging as the CLI's postgres role (bypasses RLS). Returns the rows
 * of the last SELECT. Retries the CLI's transient "login role" timeouts.
 */
export function sql(text, { file, retries = 3 } = {}) {
  const args = ['db', 'query', '--linked', '--project-ref', STAGING_REF];
  if (file) args.push('-f', file); else args.push(text);
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { json } = runCli(args);
      if (json && json._tag === 'Error') throw Object.assign(new Error(json.error?.message), { code: json.error?.code });
      return json?.rows ?? (Array.isArray(json) ? json : []);
    } catch (e) {
      lastErr = e;
      const transient = /DbConfigLoginRoleNetworkError|timed out|ECONNRESET|EAI_AGAIN/i.test(`${e.code ?? ''} ${e.message ?? ''}`);
      if (!transient || attempt === retries) throw e;
      console.error(`  (transient CLI error, retry ${attempt}/${retries - 1}: ${e.code ?? e.message})`);
    }
  }
  throw lastErr;
}

/**
 * The anon (publishable) key for staging. Taken from SUPABASE_STAGING_ANON_KEY
 * if set, otherwise fetched in-process from the Management API and kept only
 * in memory for the duration of the test run.
 */
export function getAnonKey() {
  if (process.env.SUPABASE_STAGING_ANON_KEY) return process.env.SUPABASE_STAGING_ANON_KEY;
  const { json } = runCli(['projects', 'api-keys', '--project-ref', STAGING_REF, '-o', 'json']);
  const list = Array.isArray(json) ? json : json?.api_keys ?? json?.keys ?? [];
  const anon = list.find((k) => k.name === 'anon' || k.type === 'publishable');
  if (!anon?.api_key) {
    throw new Error('Could not resolve the staging anon key. Set SUPABASE_STAGING_ANON_KEY in .env.staging.');
  }
  return anon.api_key;
}

/** SQL-literal helpers for templating fixtures. */
export const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
