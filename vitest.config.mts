import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Staging credentials come from .env.test (gitignored) or the environment.
// Variables already set in the environment win over the file. Nothing here
// reads .env.local: that file is the live project by convention.
if (existsSync(`${root}.env.test`)) process.loadEnvFile(`${root}.env.test`);

const alias = {
  '@': `${root}src`,
  // `import 'server-only'` throws outside a Next.js server bundle; stub it out.
  'server-only': `${root}tests/helpers/server-only-stub.ts`,
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // Pure functions and route validation only: no network, no TEST_SUPABASE_* needed.
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/integration/setup.ts'],
          // Real round trips to STAGING: generous timeouts, one file at a time so
          // fixtures never race each other.
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          retry: 0,
        },
      },
    ],
  },
});
