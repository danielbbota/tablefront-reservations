// =============================================================================
// Shared staging guard for every test layer (unit, integration, e2e, rls).
//
// Tests read their Supabase target from environment variables and REFUSE to run
// when that target is the production project. Nothing in here ever reads the
// keys in .env.local: by project convention that file is the live project.
//
//   TEST_SUPABASE_URL                 https://<ref>.supabase.co   (required)
//   TEST_SUPABASE_ANON_KEY            anon / publishable key      (optional*)
//   TEST_SUPABASE_SERVICE_ROLE_KEY    service-role key            (optional*)
//   TEST_SUPABASE_PRODUCTION_REFS     extra refs to block, comma-separated
//   TEST_SUPABASE_KEYS_FROM_CLI       "0" disables the CLI fallback (*)
//   TEST_SUPABASE_ALLOW_ENV_LOCAL_REF "1" allows the ref found in .env.local
//
// (*) When a key is missing and the logged-in Supabase CLI can see the project,
//     the key is fetched in-process (`supabase projects api-keys`) and kept in
//     memory only. Nothing is written to disk.
//
// This file is plain TypeScript with erasable syntax only, so Node >= 22.18
// can import it directly (tests/rls/*.mjs does) and Vitest / Playwright can
// import it without an extension.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Refs that must never be touched by tests. The TableFront live project is first. */
export const DEFAULT_PRODUCTION_REFS: readonly string[] = ['ybwedhnnygefeywdswep'];

export const ENV_URL = 'TEST_SUPABASE_URL';
export const ENV_ANON = 'TEST_SUPABASE_ANON_KEY';
export const ENV_SERVICE = 'TEST_SUPABASE_SERVICE_ROLE_KEY';

export type TestSupabase = {
  url: string;
  ref: string;
  anonKey: string;
  /** Present only when requested with `needServiceRole: true`. */
  serviceRoleKey?: string;
  /** Where each key came from: "env" or "cli". */
  sources: { anonKey: 'env' | 'cli'; serviceRoleKey?: 'env' | 'cli' };
};

export type GuardOptions = {
  /** Environment to read (defaults to process.env). Injectable for unit tests. */
  env?: Record<string, string | undefined>;
  /** Contents of .env.local, or null to skip the check (defaults to reading <cwd>/.env.local). */
  envLocal?: string | null;
  /** Project root used to locate .env.local. */
  cwd?: string;
};

export class StagingGuardError extends Error {
  constructor(message: string) {
    super(`Refusing to run tests: ${message}`);
    this.name = 'StagingGuardError';
  }
}

/** Project ref for a Supabase URL ("local" for a local `supabase start` stack), or null. */
export function refFromSupabaseUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return 'local';
  const m = u.hostname.match(/^([a-z0-9]{20})\.supabase\.(co|in|red)$/);
  return m ? m[1] : null;
}

/** The ref .env.local points at, if any. Reads only the URL line, never a key. */
export function refFromEnvLocal(contents: string | null | undefined): string | null {
  if (!contents) return null;
  const m = contents.match(/^\s*NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?(\S+?)["']?\s*$/m);
  return m ? refFromSupabaseUrl(m[1]) : null;
}

export function productionRefs(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.TEST_SUPABASE_PRODUCTION_REFS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_PRODUCTION_REFS, ...extra]));
}

function readEnvLocal(cwd: string): string | null {
  const p = resolve(cwd, '.env.local');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * Validate a Supabase URL as a test target. Throws StagingGuardError when the
 * URL is missing/malformed, matches a production ref, or matches the ref in
 * .env.local (the live project by convention).
 */
export function assertNotProduction(url: string | undefined, opts: GuardOptions = {}): { url: string; ref: string } {
  const env = opts.env ?? process.env;
  if (!url) {
    throw new StagingGuardError(
      `${ENV_URL} is not set. Point it at the STAGING project (https://<ref>.supabase.co) in .env.test or the environment.`
    );
  }
  const ref = refFromSupabaseUrl(url);
  if (!ref) {
    throw new StagingGuardError(`${ENV_URL}="${url}" is not a Supabase project URL (expected https://<ref>.supabase.co).`);
  }
  const blocked = productionRefs(env);
  if (blocked.includes(ref)) {
    throw new StagingGuardError(`${ENV_URL} points at project ${ref}, which is the PRODUCTION project. Tests only run against staging.`);
  }
  const envLocal = opts.envLocal === undefined ? readEnvLocal(opts.cwd ?? process.cwd()) : opts.envLocal;
  const localRef = refFromEnvLocal(envLocal);
  if (localRef && localRef === ref && env.TEST_SUPABASE_ALLOW_ENV_LOCAL_REF !== '1') {
    throw new StagingGuardError(
      `${ENV_URL} points at project ${ref}, the same project as .env.local. By convention .env.local is the live project, so tests never target it. ` +
        `If .env.local really is staging now, set TEST_SUPABASE_ALLOW_ENV_LOCAL_REF=1.`
    );
  }
  return { url: url.replace(/\/+$/, ''), ref };
}

// ---------------------------------------------------------------------------
// Supabase CLI helpers (best effort, in-memory only)
// ---------------------------------------------------------------------------

function parseJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* not pure JSON, fall through */
  }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i !== -1);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const closer = t[start] === '{' ? '}' : ']';
  const end = t.lastIndexOf(closer);
  if (end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function runSupabaseCli(args: string[]): { ok: boolean; json: unknown; raw: string } {
  const res = spawnSync('supabase', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, json: null, raw: res.error.message };
  const raw = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  return { ok: res.status === 0, json: parseJson(res.stdout ?? '') ?? parseJson(raw), raw };
}

type CliProject = { ref?: string; id?: string; name?: string; status?: string };

let cliProjectsCache: CliProject[] | null | undefined;

/** Projects visible to the logged-in CLI account, or null when the CLI is unavailable. Cached per process. */
export function cliProjects(): CliProject[] | null {
  if (cliProjectsCache !== undefined) return cliProjectsCache;
  const { ok, json } = runSupabaseCli(['projects', 'list', '-o', 'json']);
  if (!ok) return (cliProjectsCache = null);
  const list = Array.isArray(json) ? json : Array.isArray((json as { projects?: unknown })?.projects) ? (json as { projects: CliProject[] }).projects : null;
  return (cliProjectsCache = list);
}

/**
 * Extra belt-and-braces check: if the Supabase CLI can see the target project,
 * its name must contain "staging". Skipped (returns null) when the CLI is not
 * installed / logged in, e.g. in CI.
 */
export function assertStagingNameViaCli(ref: string): CliProject | null {
  if (ref === 'local') return null;
  const projects = cliProjects();
  if (!projects) return null;
  const project = projects.find((p) => p.ref === ref || p.id === ref);
  if (!project) return null;
  if (!/staging/i.test(project.name ?? '')) {
    throw new StagingGuardError(`project ${ref} is named "${project.name}", which does not contain "staging".`);
  }
  return project;
}

type CliKey = { name?: string; type?: string; api_key?: string };

function cliApiKeys(ref: string): CliKey[] {
  const { ok, json, raw } = runSupabaseCli(['projects', 'api-keys', '--project-ref', ref, '-o', 'json']);
  if (!ok) throw new StagingGuardError(`could not fetch API keys for ${ref} from the Supabase CLI (${raw.trim().slice(0, 200)}).`);
  const j = json as { api_keys?: CliKey[]; keys?: CliKey[] } | CliKey[] | null;
  return Array.isArray(j) ? j : j?.api_keys ?? j?.keys ?? [];
}

function pickKey(keys: CliKey[], kind: 'anon' | 'service_role'): string | undefined {
  // Prefer the legacy JWT keys (what the app uses today), fall back to the new key types.
  const legacy = keys.find((k) => k.name === kind && k.api_key);
  if (legacy?.api_key) return legacy.api_key;
  const modern = keys.find((k) => k.type === (kind === 'anon' ? 'publishable' : 'secret') && k.api_key);
  return modern?.api_key;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type ResolveOptions = GuardOptions & {
  needServiceRole?: boolean;
  /** Also ask the Supabase CLI to confirm the project name contains "staging" (default true). */
  cliCheck?: boolean;
  /** Print a note when a key was resolved from the CLI (default true). */
  log?: (msg: string) => void;
};

/**
 * Resolve the staging target for a test run. Throws StagingGuardError unless
 * TEST_SUPABASE_URL is a non-production Supabase project.
 */
export function resolveTestSupabase(opts: ResolveOptions = {}): TestSupabase {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(m));
  const { url, ref } = assertNotProduction(env[ENV_URL], opts);
  if (opts.cliCheck !== false) assertStagingNameViaCli(ref);

  let anonKey = env[ENV_ANON];
  let serviceRoleKey = env[ENV_SERVICE];
  const sources: TestSupabase['sources'] = { anonKey: 'env' };
  if (opts.needServiceRole && serviceRoleKey) sources.serviceRoleKey = 'env';

  const needCli = !anonKey || (opts.needServiceRole && !serviceRoleKey);
  if (needCli) {
    if (env.TEST_SUPABASE_KEYS_FROM_CLI === '0' || ref === 'local') {
      const missing = [!anonKey && ENV_ANON, opts.needServiceRole && !serviceRoleKey && ENV_SERVICE].filter(Boolean);
      throw new StagingGuardError(`${missing.join(' and ')} not set (CLI fallback disabled).`);
    }
    const keys = cliApiKeys(ref);
    if (!anonKey) {
      anonKey = pickKey(keys, 'anon');
      if (!anonKey) throw new StagingGuardError(`${ENV_ANON} not set and the CLI returned no anon key for ${ref}.`);
      sources.anonKey = 'cli';
      log(`  (${ENV_ANON} resolved in-process from the Supabase CLI for ${ref}; set it in .env.test to skip this)`);
    }
    if (opts.needServiceRole && !serviceRoleKey) {
      serviceRoleKey = pickKey(keys, 'service_role');
      if (!serviceRoleKey) throw new StagingGuardError(`${ENV_SERVICE} not set and the CLI returned no service_role key for ${ref}.`);
      sources.serviceRoleKey = 'cli';
      log(`  (${ENV_SERVICE} resolved in-process from the Supabase CLI for ${ref}; set it in .env.test to skip this)`);
    }
  }

  return { url, ref, anonKey: anonKey as string, serviceRoleKey: opts.needServiceRole ? serviceRoleKey : undefined, sources };
}

/**
 * Load <cwd>/.env.test into process.env without overriding variables that are
 * already set. Safe to call when the file does not exist.
 */
export function loadTestEnvFile(cwd: string = process.cwd(), file = '.env.test'): boolean {
  const p = resolve(cwd, file);
  if (!existsSync(p)) return false;
  const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof loader === 'function') {
    loader.call(process, p); // Node >= 20.12: never overrides existing variables
    return true;
  }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}
