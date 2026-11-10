import { describe, expect, it } from 'vitest';
import {
  assertNotProduction,
  DEFAULT_PRODUCTION_REFS,
  productionRefs,
  refFromEnvLocal,
  refFromSupabaseUrl,
  resolveTestSupabase,
  StagingGuardError,
} from '../helpers/staging';

const STAGING = 'https://zbzrbodraecmihzdvvot.supabase.co';
const PROD_REF = DEFAULT_PRODUCTION_REFS[0];
const PROD = `https://${PROD_REF}.supabase.co`;

describe('refFromSupabaseUrl', () => {
  it('extracts the project ref', () => {
    expect(refFromSupabaseUrl(STAGING)).toBe('zbzrbodraecmihzdvvot');
    expect(refFromSupabaseUrl(`${STAGING}/`)).toBe('zbzrbodraecmihzdvvot');
  });
  it('recognises a local stack', () => {
    expect(refFromSupabaseUrl('http://127.0.0.1:54321')).toBe('local');
    expect(refFromSupabaseUrl('http://localhost:54321')).toBe('local');
  });
  it('rejects garbage', () => {
    expect(refFromSupabaseUrl('')).toBeNull();
    expect(refFromSupabaseUrl(undefined)).toBeNull();
    expect(refFromSupabaseUrl('not a url')).toBeNull();
    expect(refFromSupabaseUrl('https://example.com')).toBeNull();
    expect(refFromSupabaseUrl('https://evil.supabase.co.attacker.com')).toBeNull();
  });
});

describe('refFromEnvLocal', () => {
  it('reads only the URL line', () => {
    const contents = `# comment\nNEXT_PUBLIC_SUPABASE_URL=${PROD}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=secret\n`;
    expect(refFromEnvLocal(contents)).toBe(PROD_REF);
    expect(refFromEnvLocal('NEXT_PUBLIC_SUPABASE_ANON_KEY=secret')).toBeNull();
    expect(refFromEnvLocal(null)).toBeNull();
  });
});

describe('productionRefs', () => {
  it('always includes the default production ref and merges extras', () => {
    expect(productionRefs({})).toEqual([...DEFAULT_PRODUCTION_REFS]);
    expect(productionRefs({ TEST_SUPABASE_PRODUCTION_REFS: 'aaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbb' })).toEqual([
      ...DEFAULT_PRODUCTION_REFS,
      'aaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbb',
    ]);
  });
});

describe('assertNotProduction', () => {
  const env = {};
  it('accepts a staging URL that differs from .env.local', () => {
    expect(assertNotProduction(STAGING, { env, envLocal: `NEXT_PUBLIC_SUPABASE_URL=${PROD}` })).toEqual({
      url: STAGING,
      ref: 'zbzrbodraecmihzdvvot',
    });
  });
  it('refuses when the URL is missing', () => {
    expect(() => assertNotProduction(undefined, { env, envLocal: null })).toThrow(StagingGuardError);
    expect(() => assertNotProduction('', { env, envLocal: null })).toThrow(/TEST_SUPABASE_URL is not set/);
  });
  it('refuses a malformed URL', () => {
    expect(() => assertNotProduction('https://example.com', { env, envLocal: null })).toThrow(/not a Supabase project URL/);
  });
  it('refuses the production project', () => {
    expect(() => assertNotProduction(PROD, { env, envLocal: null })).toThrow(/PRODUCTION/);
    expect(() => assertNotProduction(`${PROD}/`, { env, envLocal: null })).toThrow(StagingGuardError);
  });
  it('refuses extra production refs from the environment', () => {
    const extra = { TEST_SUPABASE_PRODUCTION_REFS: 'zbzrbodraecmihzdvvot' };
    expect(() => assertNotProduction(STAGING, { env: extra, envLocal: null })).toThrow(/PRODUCTION/);
  });
  it('refuses the project .env.local points at (live by convention) unless explicitly allowed', () => {
    const envLocal = `NEXT_PUBLIC_SUPABASE_URL=${STAGING}`;
    expect(() => assertNotProduction(STAGING, { env, envLocal })).toThrow(/same project as \.env\.local/);
    expect(assertNotProduction(STAGING, { env: { TEST_SUPABASE_ALLOW_ENV_LOCAL_REF: '1' }, envLocal }).ref).toBe(
      'zbzrbodraecmihzdvvot'
    );
  });
});

describe('resolveTestSupabase', () => {
  it('returns env-provided keys without touching the CLI', () => {
    const env = {
      TEST_SUPABASE_URL: STAGING,
      TEST_SUPABASE_ANON_KEY: 'anon-key',
      TEST_SUPABASE_SERVICE_ROLE_KEY: 'service-key',
      TEST_SUPABASE_KEYS_FROM_CLI: '0',
    };
    const t = resolveTestSupabase({ env, envLocal: null, needServiceRole: true, cliCheck: false, log: () => {} });
    expect(t).toMatchObject({
      url: STAGING,
      ref: 'zbzrbodraecmihzdvvot',
      anonKey: 'anon-key',
      serviceRoleKey: 'service-key',
      sources: { anonKey: 'env', serviceRoleKey: 'env' },
    });
  });
  it('omits the service-role key unless asked for', () => {
    const env = { TEST_SUPABASE_URL: STAGING, TEST_SUPABASE_ANON_KEY: 'anon-key', TEST_SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    expect(resolveTestSupabase({ env, envLocal: null, cliCheck: false, log: () => {} }).serviceRoleKey).toBeUndefined();
  });
  it('refuses production even with keys present', () => {
    const env = { TEST_SUPABASE_URL: PROD, TEST_SUPABASE_ANON_KEY: 'a', TEST_SUPABASE_SERVICE_ROLE_KEY: 'b' };
    expect(() => resolveTestSupabase({ env, envLocal: null, needServiceRole: true, cliCheck: false })).toThrow(/PRODUCTION/);
  });
  it('fails clearly when keys are missing and the CLI fallback is disabled', () => {
    const env = { TEST_SUPABASE_URL: STAGING, TEST_SUPABASE_KEYS_FROM_CLI: '0' };
    expect(() => resolveTestSupabase({ env, envLocal: null, needServiceRole: true, cliCheck: false })).toThrow(
      /TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY not set/
    );
  });
});
