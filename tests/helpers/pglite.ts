// =============================================================================
// A real PostgreSQL (PGlite: Postgres compiled to WebAssembly, in-process) with
// this project's migrations applied, for hermetic tests of what only the
// database can prove: SQL functions, constraints, grants, triggers and RLS.
//
// Supabase specifics are stubbed just enough for the migrations to run and for
// tests to act as each role:
//   - roles anon / authenticated / service_role (service_role bypasses RLS)
//   - Supabase's default privileges (new tables and functions in `public` are
//     granted to all three roles: exactly why a migration must REVOKE)
//   - auth.users and auth.uid() reading request.jwt.claims
//
// No network, no staging project, nothing shared between test files.
// =============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = resolve(process.cwd(), 'supabase/migrations');

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
  $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

/** A fresh database with every migration in supabase/migrations applied, in order. */
export async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    // gen_random_uuid() is built in since Postgres 13; PGlite has no pgcrypto.
    const sql = readFileSync(resolve(MIGRATIONS, file), 'utf8').replace(
      /create extension if not exists "pgcrypto";/gi,
      ''
    );
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return db;
}

/**
 * Run `fn` as a Supabase role. For 'authenticated', `userId` becomes
 * auth.uid() (the JWT subject), which is what RLS policies see.
 */
export async function asRole<T>(
  db: PGlite,
  role: 'anon' | 'authenticated' | 'service_role',
  userId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
  await db.exec(`set request.jwt.claims = '${claims}'; set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; reset request.jwt.claims;`);
  }
}

/** The Postgres error for a query that is expected to fail (throws if it succeeds). */
export async function pgError(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected the query to fail, but it succeeded');
}
