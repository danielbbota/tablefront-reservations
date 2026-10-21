import { defineConfig, devices } from '@playwright/test';
import { loadTestEnvFile, resolveTestSupabase } from './tests/helpers/staging';

// Staging credentials from .env.test / the environment; refuses production.
loadTestEnvFile();
// Workers re-evaluate this config: the main process hands them the resolved
// values through the environment so they never shell out to the Supabase CLI.
const target = resolveTestSupabase({ needServiceRole: true, cliCheck: process.env.E2E_TARGET_RESOLVED !== "1" });
process.env.E2E_TARGET_RESOLVED = "1";
process.env.TEST_SUPABASE_URL = target.url;
process.env.TEST_SUPABASE_ANON_KEY = target.anonKey;
process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = target.serviceRoleKey;

export const E2E_PORT = 3100;
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${E2E_PORT}`;
export const E2E_ADMIN_SECRET = process.env.E2E_ADMIN_SECRET || 'e2e-admin-secret-local-only';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Start the Next.js app on its own port, wired to STAGING. Never reuses a
  // server that is already running (a dev server on :3000 would be using
  // .env.local, i.e. the live project). Set E2E_BASE_URL to test an app you
  // started yourself with staging credentials.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${E2E_PORT}`,
        url: `${baseURL}/login`,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: target.url,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: target.anonKey,
          SUPABASE_SERVICE_ROLE_KEY: target.serviceRoleKey!,
          NEXT_PUBLIC_APP_URL: baseURL,
          ADMIN_SECRET: E2E_ADMIN_SECRET,
          CRON_SECRET: 'e2e-cron-secret-local-only',
          // Dummy key: email sends fail and are logged, never delivered.
          RESEND_API_KEY: 're_e2e_dummy_key',
          EMAIL_FROM: 'TableFront E2E <onboarding@resend.dev>',
          NEXT_TELEMETRY_DISABLED: '1',
        },
      },
});
