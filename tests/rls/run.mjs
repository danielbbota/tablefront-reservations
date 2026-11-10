#!/usr/bin/env node
// Runs both layers of the RLS tenant-isolation suite against STAGING only:
//   1. tests/rls/tenant_isolation.sql  (pure SQL, in one rolled-back transaction)
//   2. tests/rls/api.test.mjs          (real sign-in + PostgREST, node:test)
// Exit code 1 if any check fails.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingOnly, sql } from './staging.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2]; // optional: "sql" | "api"

let project;
try {
  project = assertStagingOnly();
} catch (e) {
  console.error(`\n✖ ${e.message}\n`);
  process.exit(2);
}
console.log(`\nRLS tenant-isolation tests → ${project.name} (${project.ref}, ${project.status})\n`);

let failed = 0;

if (only !== 'api') {
  console.log('── SQL layer: tests/rls/tenant_isolation.sql ──');
  try {
    const rows = sql(null, { file: resolve(here, 'tenant_isolation.sql') });
    const width = Math.max(...rows.map((r) => `${r.actor} · ${r.tbl} · ${r.action}`.length));
    for (const r of rows) {
      const label = `${r.actor} · ${r.tbl} · ${r.action}`.padEnd(width);
      console.log(`  ${r.pass ? '✔' : '✖'} ${label}  expected ${r.expected}, got ${r.actual}`);
    }
    const sqlFailed = rows.filter((r) => !r.pass).length;
    failed += sqlFailed;
    console.log(`\n  SQL layer: ${rows.length - sqlFailed}/${rows.length} passed\n`);
  } catch (e) {
    failed += 1;
    console.error(`  ✖ SQL layer could not run: ${e.message}\n`);
  }
}

if (only !== 'sql') {
  console.log('── Integration layer: tests/rls/api.test.mjs ──');
  const res = spawnSync(process.execPath, ['--test', resolve(here, 'api.test.mjs')], { stdio: 'inherit' });
  if (res.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n✖ RLS tenant isolation: FAILED (${failed} failing layer/check${failed === 1 ? '' : 's'})\n`);
  process.exit(1);
}
console.log('\n✔ RLS tenant isolation: all checks passed\n');
