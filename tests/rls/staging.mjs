// Shared helpers for the RLS tenant-isolation tests.
// Everything here talks ONLY to the STAGING Supabase project. SQL runs through
// the logged-in Supabase CLI (Management API): no database password and no
// service-role key are needed or stored on disk.
//
// The target comes from TEST_SUPABASE_URL (see .env.test.example); the shared
// guard in tests/helpers/staging.ts refuses the production project.
import { spawnSync } from 'node:child_process';
import { resolveTestSupabase } from '../helpers/staging.ts';

let resolved;
/** Resolve (once) and validate the staging target. Throws StagingGuardError otherwise. */
function target() {
  if (!resolved) resolved = resolveTestSupabase({ needServiceRole: false });
  return resolved;
}

/** Project ref of the staging project (from TEST_SUPABASE_URL). */
export function stagingRef() {
  return target().ref;
}
/** https://<ref>.supabase.co of the staging project. */
export function stagingUrl() {
  return target().url;
}

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
 * Hard guard: refuse to run unless TEST_SUPABASE_URL is a non-production
 * project that the logged-in Supabase CLI can see, with "staging" in its name.
 */
export function assertStagingOnly() {
  const { ref } = target();
  const { json } = runCli(['projects', 'list', '-o', 'json']);
  const projects = Array.isArray(json?.projects) ? json.projects : Array.isArray(json) ? json : [];
  const project = projects.find((p) => p.ref === ref || p.id === ref);
  if (!project) {
    throw new Error(`Refusing to run: project ref ${ref} is not visible to the logged-in Supabase CLI account (run \`supabase login\`).`);
  }
  if (!/staging/i.test(project.name ?? '')) {
    throw new Error(`Refusing to run: project ${ref} is named "${project.name}", which does not contain "staging".`);
  }
  return { ref, name: project.name, status: project.status };
}

/**
 * Run SQL on staging as the CLI's postgres role (bypasses RLS). Returns the rows
 * of the last SELECT. Retries the CLI's transient "login role" timeouts.
 */
export function sql(text, { file, retries = 3 } = {}) {
  const args = ['db', 'query', '--linked', '--project-ref', stagingRef()];
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
 * The anon (publishable) key for staging: TEST_SUPABASE_ANON_KEY, or fetched
 * in-process from the Management API and kept only in memory for the run.
 */
export function getAnonKey() {
  return target().anonKey;
}

/** SQL-literal helpers for templating fixtures. */
export const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
