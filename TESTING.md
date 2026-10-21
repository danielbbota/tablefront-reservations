# Testing

Four layers, one rule: **nothing ever runs against production.** Every layer that
touches Supabase reads its target from `TEST_SUPABASE_*` and refuses to start
when that target is the production project (or the project `.env.local` points
at). Unit tests never touch the network at all.

| Script | Tool | Needs staging? | What it covers |
|---|---|---|---|
| `npm test` | Vitest | integration part does | unit + integration |
| `npm run test:unit` | Vitest | no | pure logic: availability/capacity math, i18n, CORS, request validation of the public API, the staging guard itself |
| `npm run test:integration` | Vitest | yes | the public widget API route handlers against staging: config, availability, booking creation, atomic cover cap (incl. a concurrency race), tenant scoping |
| `npm run test:e2e` | Playwright | yes | the real app in Chromium: owner login/logout, dashboard redirects, manual bookings + cancel/re-confirm, the embedded guest widget end to end, admin API, CORS over HTTP |
| `npm run test:rls` | node:test + SQL | yes | Row Level Security tenant isolation (see `tests/rls/README.md`) |
| `npm run test:all` | all of the above | yes | unit → integration → rls → e2e |

Also: `npm run test:watch` (unit tests in watch mode) and
`npm run test:e2e:ui` (Playwright UI mode).

## One-time setup

```bash
npm ci
npx playwright install chromium        # e2e only
cp .env.test.example .env.test         # then edit
```

`.env.test` (gitignored) holds the **staging** project:

```
TEST_SUPABASE_URL=https://zbzrbodraecmihzdvvot.supabase.co
TEST_SUPABASE_ANON_KEY=...            # optional locally, see below
TEST_SUPABASE_SERVICE_ROLE_KEY=...    # optional locally, see below
```

Keys: if you leave them empty and the Supabase CLI is logged in
(`supabase login`), the runners fetch them in-process from the Management API
for the project in `TEST_SUPABASE_URL` and keep them in memory only. Fill them
in to skip that (and in CI, where there is no CLI).

Never copy values from `.env.local` into `.env.test`: `.env.local` is the live
project, and the guard rejects its ref anyway.

## The staging guard

`tests/helpers/staging.ts` is imported by the Vitest integration setup, the
Playwright config and the RLS runner. Before any test runs it:

1. requires `TEST_SUPABASE_URL` and parses the project ref out of it;
2. refuses if the ref is the production project (`ybwedhnnygefeywdswep`, plus
   anything in `TEST_SUPABASE_PRODUCTION_REFS`);
3. refuses if the ref equals the one in `.env.local` (override with
   `TEST_SUPABASE_ALLOW_ENV_LOCAL_REF=1` only if `.env.local` really is staging);
4. if the Supabase CLI is available and can see the project, refuses unless the
   project name contains "staging".

Refusals exit before a single request is made. `tests/unit/staging-guard.test.ts`
covers the guard itself.

## Layer by layer

### Unit (`tests/unit`)

Plain Vitest, `environment: node`, `@/` resolves to `src/`, `server-only` is
stubbed. Route handlers are called directly with a `NextRequest`; the Supabase
client is mocked to prove invalid input is rejected before any DB access.
Time-dependent code uses `vi.useFakeTimers()`.

### Integration (`tests/integration`)

`tests/integration/setup.ts` runs first in every file: it resolves the staging
target and exports it to the variables the app reads
(`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, …), with a dummy
Resend key so no email is ever sent. Each file creates its own throwaway
restaurant (`slug = test-int-<run>`) and deletes it in `afterAll`; leftovers
older than one hour from crashed runs are swept on the next run. Files run one
at a time (`fileParallelism: false`).

### End to end (`tests/e2e`)

`playwright.config.ts` starts `next dev -p 3100` with the staging credentials
injected through the environment (Next never overrides variables that are
already set, so `.env.local` is ignored). It never reuses a running server:
your usual `npm run dev` on :3000 is on the live project.

`global-setup.ts` creates one restaurant + one owner on staging and records
them in `tests/e2e/.state/fixture.json` (gitignored); `global-teardown.ts`
deletes both. Specs:

- `auth.spec.ts` – redirects, wrong password, login, `/login` bounce, sign out
- `bookings.spec.ts` – add a manual booking, see it listed, cancel, re-confirm;
  server-side validation errors
- `widget.spec.ts` – `widget.js` embedded on a foreign-origin host page: pick a
  date, see 20 slots, book for 3, see the confirmation, availability drops by 3
- `public-api.spec.ts` – CORS and validation over real HTTP, admin/cron locked
- `admin-api.spec.ts` – create a restaurant + owner through `/api/admin/restaurants`

To test an app you started yourself (with staging credentials!), set
`E2E_BASE_URL=http://localhost:3100` and, for the admin test,
`E2E_ADMIN_SECRET` to that app's `ADMIN_SECRET`.

Failure artifacts (traces, screenshots) land in `test-results/`; open a trace
with `npx playwright show-trace test-results/<...>/trace.zip`.

### RLS (`tests/rls`)

Unchanged in scope, now wired to the same `TEST_SUPABASE_URL` guard. It runs SQL
through the logged-in Supabase CLI (`supabase db query --linked --project-ref …`),
so it needs `supabase login` but no database password. Details and the table of
checks: `tests/rls/README.md`.

**Known red (2026-10-21):** eight SQL checks and one API check fail on staging on
purpose: `create_widget_booking()` is executable by `anon`/`authenticated`, and
`floor_tables.zone_id` / `booking_tables.{booking_id,table_id}` are not
tenant-checked. The fix is drafted in
`tests/rls/proposed/0005_tenant_isolation_fixes.sql`; apply it to staging, re-run
`npm run test:rls`, then promote. See AUDIT.md section 2.

## Continuous integration

`.github/workflows/test-unit.yml` runs `tsc --noEmit` and `npm run test:unit` on
every push and pull request to `week/platform-hardening` (Node 22, `npm ci`). It
needs no secrets. Integration, RLS and e2e stay local on purpose: they need the
staging service-role key and the Supabase CLI; if you later want them in CI, add
`TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY` and
`TEST_SUPABASE_SERVICE_ROLE_KEY` as repository secrets and add a job with
`npx playwright install --with-deps chromium`.

## Troubleshooting

- **"Refusing to run tests: TEST_SUPABASE_URL is not set"** – create `.env.test`
  from `.env.test.example`.
- **"… is the PRODUCTION project"** – you pointed `TEST_SUPABASE_URL` at the live
  project. Use staging.
- **`next dev` never comes up / `Timed out waiting … webServer`** – this checkout
  lives in iCloud Drive; if iCloud has evicted `node_modules` (files show as
  `dataless` in `ls -lO`), every module read becomes a download. `npm ci`
  re-materialises them. Also delete a stale `.next/dev/lock` left by a killed
  dev server.
- **Leftover fixtures on staging** – rows with slugs `test-int-*`, `test-e2e-*`,
  `rls-test-*` and users `e2e-owner-*@example.test` / `rls-test-owner-*@example.test`
  are test fixtures; every runner sweeps ones older than an hour.
