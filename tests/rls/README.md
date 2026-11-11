# RLS tenant-isolation tests (STAGING only)

Proves that one restaurant (tenant) can never read or write another tenant's
rows through Row Level Security — the verdict AUDIT.md section 2 asks for.

```bash
npm run test:rls          # both layers
npm run test:rls -- sql   # SQL layer only
npm run test:rls -- api   # integration layer only
```

## Guard rails

- The target comes from `TEST_SUPABASE_URL` in `.env.test` (see
  `.env.test.example`). The shared guard in `tests/helpers/staging.ts`
  **refuses** the production project ref and the project `.env.local` points at.
- Before anything runs, `tests/rls/staging.mjs` additionally lists the CLI
  account's projects and **refuses** unless that ref exists and its name
  contains "staging".
- Never reads the keys in `.env.local`. No service-role key or DB password is
  required or stored: SQL runs through `supabase db query --linked
  --project-ref …` (Management API, needs `supabase login`), and the anon key
  comes from `TEST_SUPABASE_ANON_KEY` or is fetched in-process.
- Requires Node ≥ 22.18 (imports the TypeScript guard directly).

## What it covers

Fixtures: Restaurant A and Restaurant B, one owner user each, 3 bookings each,
one capacity rule, one floor zone, one floor table and one booking↔table
assignment each.

Actors: **owner A** (authenticated, JWT `sub` = owner A) and **anon**.

Attempts against tenant B, each expected to fail (0 rows, or `42501` on insert):

| table | select | update | delete | insert | extra |
|---|---|---|---|---|---|
| `bookings` | ✓ | ✓ | ✓ | ✓ | move own row into B, `create_widget_booking` RPC for B |
| `restaurants` (settings) | ✓ | ✓ | ✓ | ✓ | |
| `capacity_rules` (settings) | ✓ | ✓ | ✓ | ✓ | |
| `owners` | ✓ | ✓ (re-point own membership) | | ✓ | |
| `floor_zones` | ✓ | ✓ | ✓ | ✓ | |
| `floor_tables` | ✓ | ✓ | ✓ | ✓ | own table placed in B's zone |
| `floor_elements` (SQL layer) | ✓ | ✓ | ✓ | ✓ | |
| `booking_tables` | ✓ | | ✓ | ✓ | own booking → B table, B booking → own table |

Positive controls confirm the harness really runs as owner A (sees exactly 3 own
bookings, can edit them). A final block re-reads tenant B from outside RLS
(postgres) to prove nothing changed and nothing was written on B's behalf.

## Layers

- `tenant_isolation.sql` — one transaction, `set local role authenticated` +
  `request.jwt.claims`, then `set local role anon`; ends with `ROLLBACK`, so
  fixtures never persist. Results are the rows of the final `SELECT`.
  Can also be pasted into the **staging** SQL editor.
- `api.test.mjs` — `node:test`; seeds fixtures via SQL, signs in as owner A/B
  with `@supabase/supabase-js`, hits PostgREST like the dashboard does, and
  deletes the fixtures in `after()`. Stale `rls-test-*` fixtures older than one
  hour are swept at the start of each run.

## Stays and appointments (`verticals_isolation.sql`)

Same contract as `tenant_isolation.sql`, for everything migration 0006 added:
`payment_accounts`, `stay_units`, `stay_rates`, `stay_ical_feeds`,
`stay_reservations`, `stay_blocks`, `services`, `staff`, `staff_services`,
`staff_time_off`, `appointments`. As owner A and as anon it tries to read,
update, delete and insert tenant B's rows, move an own row into B, hang an own
row off one of B's parents (unit, feed, staff, service), write
`payment_accounts`, change `business_type`, and call
`create_stay_reservation()` / `create_appointment()`.

## State on staging (2026-11-11)

Migrations 0001–0006 are applied; every check in both SQL files and in
`api.test.mjs` passes. The gaps listed in AUDIT.md section 2 were closed by
`supabase/migrations/0005_tenant_isolation_fixes.sql`.
