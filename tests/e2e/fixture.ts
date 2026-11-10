// Fixture bookkeeping shared by global setup/teardown and the specs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { refFromSupabaseUrl, productionRefs } from '../helpers/staging';

export type E2EFixture = {
  run: string;
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerPassword: string;
};

// Playwright compiles these files to CommonJS, so __dirname is available.
export const STATE_FILE = resolve(__dirname, '.state', 'fixture.json');

export function writeFixture(fx: E2EFixture) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(fx, null, 2));
}
export function readFixture(): E2EFixture {
  if (!existsSync(STATE_FILE)) throw new Error('e2e fixture missing: did global setup run?');
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2EFixture;
}
export function removeFixtureFile() {
  rmSync(dirname(STATE_FILE), { recursive: true, force: true });
}

/** Service-role client for STAGING, built from the TEST_SUPABASE_* resolved by playwright.config.ts. */
export function stagingAdmin(): SupabaseClient {
  const url = process.env.TEST_SUPABASE_URL!;
  const ref = refFromSupabaseUrl(url);
  if (!ref || productionRefs().includes(ref)) throw new Error(`Refusing to touch ${url}`);
  return createClient(url, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const OPEN_ALL_WEEK = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '12:00', close: '22:00', closed: false }])
);

/** YYYY-MM-DD `days` ahead (UTC date; fixtures stay well inside the 60-day horizon). */
export function isoDateFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
