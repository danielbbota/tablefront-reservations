# TableFront Reservations — Security & Correctness Audit

Audit date: 2026-10-21. Repo: `tablefront-reservations` (Next.js 16.2.10, React 19, Supabase, Resend).
No application code was changed. The only file added by this audit is this one.

## 0. Scope, environment check, and what I could not verify

**Environment.** The task said "staging Supabase only, never production".

| Item | Result |
|---|---|
| Project ref in `.env.local` (`NEXT_PUBLIC_SUPABASE_URL` host) | `ybwedhnnygefeywdswep` |
| Only project visible to the logged-in Supabase CLI account | `tablefront-reservations-staging`, ref `zbzrbodraecmihzdvvot` |
| Do the two match? | **No.** `.env.local` points at a project that is not the staging project and is not visible to this account. Treat it as production or unknown. |
| `supabase/.temp/linked-project.json` | Linked to the staging project (name `tablefront-reservations-staging`). |

So: **nothing in this audit connected to the `.env.local` project.** Every live check ran against staging
(`zbzrbodraecmihzdvvot`) only, through the Supabase CLI Management API, without service-role key or DB password:

- `npm run test:rls` (existing harness in `tests/rls`, hard-pinned to the staging ref, creates and deletes fixtures). Afterwards I confirmed staging had zero leftover fixtures and exactly one restaurant (the seed).
- Read-only catalog queries on staging: RLS flags, policies, function ACLs, anon table grants.
- One read-only `GET /auth/v1/settings` on staging.

`CLAUDE.md` contains only `@AGENTS.md`, and `AGENTS.md` only says "this is not the Next.js you know, read `node_modules/next/dist/docs/`". There are no project-specific rules to audit against.

**Could not verify (stated plainly):**

1. Anything about the production database. Whether production has the same grants, policies, data, or the `0005` fixes is unknown. Production was built from the same four migrations, so assume it has the same holes until proven otherwise.
2. Which Supabase project `ybwedhnnygefeywdswep` is. I did not touch it.
3. Vercel production environment variables. The Vercel connector returned 403 on env listing, and the CLI is not linked in this folder.
4. Vercel Firewall / rate-limit rules. The firewall config call returned 404 "not found", which most likely means no custom rules, but I cannot prove it.
5. Whether open sign-up is enabled in production Auth. On staging it is enabled (`disable_signup: false`).
6. Behaviour under real concurrent load. Atomicity in section 4 is argued from the SQL, not load-tested.
7. Whether the Next.js proxy-bypass advisory applies. It is reported by `npm audit` for Turbopack with a single locale. I did not test it.
8. Email deliverability, Resend domain verification, and any legal/GDPR position.

## 1. Architecture summary

```
                    restaurant's own website
  ┌──────────────────────────────────────────────────────────┐
  │ <div data-tablefront-widget data-restaurant="<uuid>">    │
  │ <script src=".../widget.js">  (vanilla JS, Shadow DOM)   │
  └───────────────┬──────────────────────────────────────────┘
                  │ CORS "*", no auth, no accounts
                  ▼
   GET  /api/public/config        ┐
   GET  /api/public/availability  ├─ service-role Supabase client (bypasses RLS,
   POST /api/public/bookings      ┘  scopes by restaurant_id in code)
                  │                       │
                  │ rpc create_widget_booking  (advisory lock + cap check + insert)
                  ▼                       │
        Postgres (RLS on every table) ◄───┘
                  ▲
                  │ anon key + owner's session JWT  →  RLS via my_restaurant_id()
   Owner dashboard (server components + server actions)
   /day  /  /bookings/new  /bookings/[id]/edit  /floor-plan  /settings
                  ▲
   src/proxy.ts: refresh session cookie; redirect to /login if no user
```

**Guest booking.** `public/widget.js` loads config, then availability for a date, then POSTs a booking. The POST handler (`src/app/api/public/bookings/route.ts`) validates the fields, checks the slot is on the restaurant's grid and inside the 60-day window (in the restaurant's timezone), resolves the cover cap from `capacity_rules`, and calls the Postgres function `create_widget_booking`. That function takes an advisory lock per restaurant+date+slot, sums confirmed covers, and inserts or raises `SLOT_FULL`. The handler then sends a guest confirmation and an owner notification through Resend. Email errors are swallowed.

**Guest cancel.** Every guest email contains `/cancel/<cancel_token>`. The token is a random UUID stored on the booking and is the only credential. The page and its inline server action use the service-role client keyed on the token.

**Dashboard.** Owners sign in with Supabase Auth (email + password). `src/proxy.ts` refreshes the session cookie and redirects anonymous visitors to `/login`. All dashboard reads and writes use the cookie-based client with the anon key, so Postgres RLS is the real access control. Pages: day view with live floor map, bookings list, manual booking, edit booking, floor-plan editor, settings (hours, cap, interval, turn time, language, timezone).

**Tenant scoping.** One table, `owners`, maps `auth.users.id` to exactly one `restaurant_id`. The `SECURITY DEFINER` function `my_restaurant_id()` returns the caller's restaurant, and every tenant table has an RLS policy of the form `restaurant_id = my_restaurant_id()`. The service-role paths bypass RLS and scope by hand (section 2). A user belongs to one restaurant only, and there are no roles: every owner is a full admin.

**Admin.** `/admin` is a public page that posts to `POST /api/admin/restaurants` with an `x-admin-secret` header. It creates the restaurant, the Auth user (email pre-confirmed) and the `owners` row.

**Emails.** Resend, plain text, one shared `EMAIL_FROM` for all tenants. Confirmation and owner notice are sent inline on booking. Cancellation emails are sent from the dashboard and the guest cancel page. A daily Vercel cron (`vercel.json`, 09:00 UTC, region `fra1`) sends a reminder for "tomorrow" in each restaurant's own timezone, once per booking.

## 2. Supabase tables, RLS policies, and tenant-isolation verdict

Evidence: the policy text below was read live from `pg_policies` on **staging** and matches the migrations. Behaviour was tested with `tests/rls` on staging (as owner A against tenant B, and as anon):

| Layer | Passed | Failed |
|---|---|---|
| SQL (one rolled-back transaction) | 66 of 74 | 8 |
| API (real sign-in, PostgREST) | 50 of 56 | 6 |

Every failure traces to three root causes, listed after the table verdicts (F1, F2, F3). No test found a way for one owner to **read** another tenant's rows.

All 8 tables have RLS enabled and **no** table has `FORCE ROW LEVEL SECURITY`. No policy has a `TO` clause, so every policy applies to the `public` role; anon is blocked only because `my_restaurant_id()` returns NULL without a JWT.

Helper used by every policy (`0001_init.sql:92-100`):

```sql
create or replace function public.my_restaurant_id() returns uuid
language sql stable security definer set search_path = public
as $$ select restaurant_id from public.owners where id = auth.uid() $$;
```

### Table by table

**`restaurants`** (`0001_init.sql:106-113`). Policies: SELECT and UPDATE only. No INSERT or DELETE policy, so owners cannot create or delete restaurants (tested: rejected).

```sql
"owners read own restaurant"   FOR SELECT USING (id = my_restaurant_id())
"owners update own restaurant" FOR UPDATE USING (id = my_restaurant_id())
                                          WITH CHECK (id = my_restaurant_id())
```

Verdict: **isolated.** Owners can edit any column of their own row through PostgREST, including `slug`.

**`owners`** (`0001_init.sql:102-104`). SELECT only; nobody but service-role can insert, update or delete, so an owner cannot re-point their membership at another restaurant (tested).

```sql
"owners read own row" FOR SELECT USING (id = auth.uid())
```

Verdict: **isolated.**

**`capacity_rules`** (`0001_init.sql:115-118`).

```sql
"owners manage own capacity rules" FOR ALL
  USING (restaurant_id = my_restaurant_id())
  WITH CHECK (restaurant_id = my_restaurant_id())
```

Verdict: **isolated.**

**`bookings`** (`0001_init.sql:120-123`).

```sql
"owners manage own bookings" FOR ALL
  USING (restaurant_id = my_restaurant_id())
  WITH CHECK (restaurant_id = my_restaurant_id())
```

Table access: **isolated** (select, update, delete, insert-for-B and move-row-into-B all rejected). But see **F1**: the `create_widget_booking` function writes to this table for any caller.

**`floor_zones`** (`0004_floor_plan.sql:75-78`). Same `FOR ALL` pattern on `restaurant_id`. Verdict: **isolated.**

**`floor_tables`** (`0004_floor_plan.sql:80-83`) and **`floor_elements`** (`0004_floor_plan.sql:85-88`). Same pattern.

```sql
"owners manage own floor tables" FOR ALL
  USING (restaurant_id = my_restaurant_id())
  WITH CHECK (restaurant_id = my_restaurant_id())
```

Verdict: rows cannot be read or changed across tenants, **but see F2**: `zone_id` is a plain foreign key, so an owner can place their own table or element in another tenant's zone.

**`booking_tables`** (`0004_floor_plan.sql:90-93`). Same pattern. Verdict: reads and deletes isolated, **but see F3**: `booking_id` and `table_id` are plain foreign keys.

### The three confirmed gaps

**F1 — CRITICAL: anyone can call `create_widget_booking` and write to any tenant.** `0001_init.sql:178-179` and `0003_guest_lang_reminders_service.sql:71` run `revoke execute ... from anon, authenticated`. That does nothing, because Postgres grants EXECUTE to `PUBLIC` on every new function and the `PUBLIC` grant was never revoked. Live ACL on staging:

```
create_widget_booking(...)  {=X/postgres, postgres=X/postgres, service_role=X/postgres}
                              ^^^^^^^^^^ PUBLIC can execute
```

The function is `SECURITY DEFINER` (bypasses RLS) and takes the cover cap as a parameter from the caller. Confirmed on staging: an anon call and an owner-A call both inserted a confirmed booking into tenant B (the test row was `RLS-HACKED`, date 2030-01-01) with no cap check, no slot-grid check, no horizon check, no email and no rate limit. The anon key is public by design (it ships in the browser bundle), and each restaurant's UUID is public in its website's widget snippet. Cross-tenant **write**: yes. Cross-tenant **read**: no, since the function only returns the row it just inserted. `my_restaurant_id()` has the same stray `PUBLIC` grant, which is harmless because it returns NULL for anon.

**F2 — MEDIUM: cross-tenant reference on `floor_tables.zone_id` / `floor_elements.zone_id`.** RLS checks only `restaurant_id`, so owner A can insert a row owned by A that points at B's zone. Confirmed on staging. Impact is low: B cannot see A's row, and B deleting their zone cascades away A's row. It does give an oracle for whether a guessed UUID exists.

**F3 — MEDIUM: cross-tenant reference on `booking_tables`.** The same flaw for `booking_id` and `table_id`: owner A can link A's booking to B's table, or B's booking to A's table. Confirmed on staging, and it is also reachable through the normal `updateBooking` server action (see item M6 in section 5).

A reviewed fix for all three exists, **unapplied**, at `tests/rls/proposed/0005_tenant_isolation_fixes.sql`. I read it: it revokes `PUBLIC` on both functions, grants `service_role` only, and replaces the foreign keys with composite `(id, restaurant_id)` keys. I did not apply it.

### Service-role code paths (RLS bypassed, scoping done by hand)

| Path | Scoping | Verdict |
|---|---|---|
| `GET /api/public/availability` | `restaurant_id` filter on rules and bookings | OK |
| `GET /api/public/config` | selects by id, returns id, name, language only | OK |
| `POST /api/public/bookings` | restaurant id from body, passed to RPC; owner email looked up by that id | OK |
| `/cancel/[token]` and its action | keyed on the unguessable token only; update also requires `status = 'confirmed'` | OK |
| `GET /api/cron/reminders` | all restaurants by design; each booking query filtered by restaurant | OK |
| `POST /api/admin/restaurants` | admin secret; creates a new tenant | OK, see M8 |
| `setBookingStatus` in `src/app/actions.ts:79` | after an RLS-scoped update, reads that booking's restaurant by id | OK |

### Overall verdict

For **table access through PostgREST and the dashboard**, one tenant cannot read or write another tenant's rows. **That is not true overall**, because of F1: any anonymous caller can insert bookings into any tenant today, on staging, and very likely in production. F2 and F3 let one tenant plant rows that reference another tenant's objects but expose no data.

Smaller RLS observations:

- The Supabase default grants give `anon` and `authenticated` TRUNCATE, TRIGGER and REFERENCES on all eight tables (confirmed on staging). RLS does not govern TRUNCATE. It is not reachable through PostgREST, but it is needless exposure (L3).
- Single-restaurant-per-user and no roles means any staff login can change settings and delete the floor plan.

## 3. Public endpoints and server actions

**Rate limiting: there is none anywhere.** No rate-limit dependency is in `package.json`, no code throttles anything, and the Vercel firewall config lookup returned "not found" (likely no custom rules; unverified). Supabase Auth applies its own sign-in limits, which is the only throttle on the whole app. "Validated" below means input checks in app code; the database `CHECK` constraints are the backstop.

### HTTP endpoints

| Endpoint | Auth | Accepts | Returns | Validation | Rate limited |
|---|---|---|---|---|---|
| `GET /api/public/config` (`config/route.ts`) | none, CORS `*` | `restaurant` | restaurant id, name, language, max party size, horizon | `restaurant` only checked for presence; a non-UUID just yields 404 | No |
| `GET /api/public/availability` (`availability/route.ts:15`) | none, CORS `*` | `restaurant`, `date` | restaurant id and name, per-slot remaining covers | date matched by regex only (line 19), so `2026-02-31` rolls over silently; horizon enforced (37) | No. Each call runs 3 queries |
| `POST /api/public/bookings` (`bookings/route.ts:30`) | none, CORS `*` | restaurant, date, time, partySize, name, phone, email, notes, lang | `201` with booking id, date, time, party size, status; `409 SLOT_FULL`; `400`; `500` | Good: party size 1-12 integer, name at most 120, phone at most 40, email regex, notes cut at 1000, lang allowlist, slot must be on the grid, not past, inside 60 days. Weak: no real-date check (500 on `2026-02-31`), phone has no format check | **No** |
| `GET /widget.js` | none | n/a | static script | n/a | CDN only |
| `GET /cancel/[token]` plus inline action `cancelBooking` (`cancel/[token]/page.tsx:85`) | possession of token | token in path | booking summary and a cancel button | token is a UUID column; a malformed token simply finds nothing. The action only flips `confirmed` to `cancelled`, so it is idempotent | No (122-bit token, so guessing is infeasible) |
| `POST /api/admin/restaurants` (`admin/restaurants/route.ts:20`) | `x-admin-secret` header | name, slug, timezone, language, interval, cap, ownerEmail, ownerPassword, operatingHours | `201` with ids, owner email, embed snippet | name and slug required, email only needs an `@`, password at least 8, timezone checked. `operatingHours` is stored unchecked (line 65); interval and cap rely on DB checks | No. Secret compared with `!==` (line 22) |
| `GET /api/cron/reminders` (`cron/reminders/route.ts:20`) | `Authorization: Bearer $CRON_SECRET` | none | `{sent, failures}` | n/a | No. **If `CRON_SECRET` is unset the header `Bearer undefined` passes (line 21)** |
| `GET /admin` | none | n/a | admin form (public page; the API holds the secret check) | n/a | No |
| `GET /login` | none | `?error=` | form, reflects the error text | text is escaped by React, but it is attacker-controlled copy (L2) | No (Supabase Auth limits only) |

`src/proxy.ts` gates everything else on "a Supabase user exists". It does not check that the user has an `owners` row.

### Server actions (all POST, all behind the proxy session check, all run under the owner's RLS session unless noted)

| Action (`src/app/actions.ts` unless noted) | Accepts from client | Validation | Notes |
|---|---|---|---|
| `login` (51) | email, password | none beyond Supabase | generic error message, no enumeration; no app-level throttle |
| `logout` (61) | none | n/a | |
| `setBookingStatus` (67) | booking id, status | status is only a TS type; DB `CHECK` limits it to confirmed or cancelled | RLS scopes the row. Re-confirming a cancelled booking skips the cap. Every call with `cancelled` re-sends the cancellation email (L4) |
| `setServiceStatus` (91) | booking id, status, date | status via DB `CHECK`; `date` is **not validated** and is interpolated into a redirect path (102) | RLS scoped |
| `createManualBooking` (114) | party, date, time, name, phone, email, notes, table | name required, date and time by regex, party at least 1 (DB caps at 50); no email or phone validation | **No capacity check, by design** (line 146) |
| `updateBooking` (182) | booking id plus the same fields | same | No capacity check (202). **Does not check that the update matched a row** (204-218), see M6 |
| `saveSettings` (241) | interval, cap, turn time, timezone, hours, language, per-day caps | good: ranges, timezone via `Intl`, open before close, language allowlist | Deletes then re-inserts cap overrides without a transaction (298-322) |
| `saveFloorPlan` (`floor-actions.ts:58`) | whole plan as JSON | UUID shape, counts (8 zones, 120 tables, 200 elements), clamped numbers, shape and kind allowlists | Not atomic; delete errors ignored (119-143) |
| `assignBookingTable` (155) | booking id, table id, force | UUID shape; row lookups run under RLS | Overlap check is advisory and non-atomic, see section 4 |
| `createWalkIn` (235) | date, time, party, label | regexes; party clamped 1-50 | No capacity check |
| `seatWalkIn` (276) | table id, date, time, party, label | same | No capacity check; table lookup is RLS scoped |
| `cancelBooking` (`cancel/[token]/page.tsx:85`) | closed-over token | see HTTP table | service-role |

All actions called from client components accept arbitrary caller-supplied arguments, since a server action is a public POST endpoint. Where an action has no explicit validation (status values, ids), safety rests on RLS and `CHECK` constraints, and that holds today.

## 4. Where booking capacity is checked, and is it atomic?

"Capacity" here means the online cover cap per time slot (`capacity_rules` or `restaurants.default_max_covers`), plus the separate table-overlap check on the floor plan.

| # | Place | What it does | Binding? | Atomic with the insert? |
|---|---|---|---|---|
| 1 | `public/widget.js:270-272` | Hides slots where `remaining < party size` | No, UI only | n/a |
| 2 | `src/lib/availability.ts:92-108`, used by `availability/route.ts:62` | `remaining = cap - booked`, with `booked` summed per exact slot string | No, display only | n/a. A read, so stale the moment it returns |
| 3 | `bookings/route.ts:79-84` | Resolves the cap from rules and passes it to the database function as `p_max_covers` | Computed outside the transaction | No, but harmless on its own |
| 4 | `create_widget_booking`, `0003_guest_lang_reminders_service.sql:43-56` | Takes `pg_advisory_xact_lock(hashtext(restaurant‖date‖slot))`, sums confirmed covers for that slot, raises `SLOT_FULL` if over, then inserts | **Yes, the only real enforcement** | **Yes, for widget-vs-widget** |
| 5 | `floor-actions.ts:190-219` (`assignBookingTable`) | Rejects a table assignment if another confirmed booking on that table starts within `turn_time` minutes | Soft; `force=true` overrides it | **No.** Read, then delete, then insert, with no lock |

**Not checked at all:** `createManualBooking` (`actions.ts:146`, deliberate), `updateBooking` (`actions.ts:202`, deliberate), `setBookingStatus` when re-confirming a cancelled booking (`actions.ts:67-76`), `createWalkIn` and `seatWalkIn` (`floor-actions.ts:235, 276`). The README says manual bookings are never blocked, but it does not mention that reactivating a cancelled booking or changing the date, time or party size of an existing one also skips the cap.

**Verdict on atomicity (by reading the SQL; not load-tested):**

- Two concurrent widget bookings for the same slot cannot both take the last covers. The transaction-level advisory lock is held until commit, and under READ COMMITTED the `SUM` runs after the lock is acquired, so it sees the previous holder's committed row. `hashtext` is 32-bit, so unrelated slots can collide, which only adds waiting, not wrong results.
- Check-and-insert is **not** atomic against any other writer. Manual bookings, walk-ins, edits and reactivations take no lock, so a widget booking that has already summed the slot can commit just after a staff insert and the slot ends up over the cap. This is within the "manual is never blocked" design, but the number shown to guests can be wrong by the size of that party.
- The cap itself is supplied by the caller (`p_max_covers`), so the atomic check is only as trustworthy as the caller. Because of **F1**, anyone can pass any cap. Until the grant is fixed, the atomic check protects nothing against a hostile caller.
- Table assignment (row 5) is a check-then-act race: two staff members can double-book a table. It also ignores party size versus `seats` and `combinable_group`, so a party of 8 can be assigned to a 2-seat table without a warning.
- The cap is per exact slot, not per seating window. With a 30-minute grid, a 24-cover cap and a 90-minute turn time, up to 72 covers can be seated at once. That is a modelling choice rather than a bug, but nothing in the product shows it. See M3 for the case where the grid changes.

## 5. Ranked bugs and risks

Severity reflects what is provable from the code and from staging. "Unverified" marks anything that depends on production state I could not see.

### Critical

**C1. Anyone can insert bookings into any restaurant, bypassing the cap.** `supabase/migrations/0001_init.sql:178-179`, `supabase/migrations/0003_guest_lang_reminders_service.sql:71`. The revoke targets `anon` and `authenticated`, but `PUBLIC` still holds EXECUTE on a `SECURITY DEFINER` function that trusts a caller-supplied cap. Confirmed on staging with the public anon key and with a signed-in owner of a different tenant. Production state is unverified but very likely identical. **Fix:** apply `tests/rls/proposed/0005_tenant_isolation_fixes.sql` (revoke from `public, anon, authenticated`, grant to `service_role`), then re-run `npm run test:rls`.

### High

**H1. The public booking endpoint can be used to fill every slot and to send email as the restaurant.** `src/app/api/public/bookings/route.ts:30-141`, `src/lib/email.ts:64-76`. There is no rate limit, no bot check and no per-email limit. Anyone can book out a restaurant's capacity for 60 days, and each booking sends a message to an attacker-chosen address from the shared sender, with attacker-chosen text in the name (120 chars) and notes (1000 chars). That is a phishing and spam relay on your sender reputation. **Fix:** add a per-IP and per-restaurant rate limit (Vercel WAF rule or a Redis limiter) plus a bot challenge, and cap bookings per email per day.

**H2. Next.js 16.2.10 sits inside a long list of published advisories.** `package.json:16`. `npm audit --omit=dev` reports one critical and several high findings on `next` (range up to 16.3.7 or 16.3.8), including a middleware/proxy bypass, server-action denial of service, image-optimization and SSRF issues, plus high findings in transitive `sharp`, `postcss`, `nanoid` and `source-map-js`. This app uses neither `next/image` nor `next/og`, so the critical remote-code-execution items probably do not apply, and the Windows-host one does not apply on Vercel. The proxy-bypass item matters because `src/proxy.ts` is the only page gate, though RLS still protects the data. Applicability was not tested. **Fix:** upgrade `next` and `eslint-config-next` to the version `npm audit` offers (16.4.2) and rerun `npm audit`.

**H3. The local environment points at a project that is not staging, and it holds the service-role key.** `.env.local:2` and `:4`. Running `npm run dev` or any script from this machine hits that project with full RLS bypass. `.env.local` is correctly gitignored, and git history contains no JWT or API-key patterns (0 matches across 10 commits). **Fix:** replace the local values with the staging project's; keep production keys only in Vercel, and add a startup guard that refuses to boot in development when the Supabase ref is not in an allowlist.

### Medium

**M1. The cron endpoint accepts `Bearer undefined` when `CRON_SECRET` is unset.** `src/app/api/cron/reminders/route.ts:21`. Anyone could trigger the reminder run. The local secret is set (48 characters); production is unverified. **Fix:** reject with 401 when `CRON_SECRET` is empty, before comparing the header.

**M2. Open sign-up, and the proxy treats any signed-in user as authorized.** `src/proxy.ts:36`. Staging has `disable_signup: false`. A stranger can create an account, reach every dashboard page shell, and (via C1) call the booking function as `authenticated`. RLS shows them no tenant data. **Fix:** disable sign-up in Auth settings and have the proxy or layout require a matching `owners` row.

**M3. Capacity is counted per exact slot string, so off-grid bookings escape the cap.** `supabase/migrations/0003_guest_lang_reminders_service.sql:47-52`, `src/app/api/public/availability/route.ts:56-60`, `src/app/actions.ts:250-254`. Changing the slot interval in settings, or any manual booking or walk-in at a time that is not on the grid (for example 19:15 on a 30-minute grid), is never counted toward any slot, so the slot can be oversold. **Fix:** sum confirmed covers whose start falls inside `[slot, slot + interval)`, in both the function and the availability route.

**M4. Reactivating or editing a booking skips the cap with no warning.** `src/app/actions.ts:67-76`, `:182-216`. Setting a cancelled booking back to confirmed, or raising its party size, can overbook a slot silently. **Fix:** compute the slot total on those paths and show a confirmation when it exceeds the cap.

**M5. Failed reminder emails are lost and reported as sent.** `src/app/api/cron/reminders/route.ts:49-64`, `src/lib/email.ts:54-62`. The booking is marked `reminder_sent_at` first, and `send()` swallows every error, so `sendGuestReminder` never throws; `failures` is always empty and the guest is never retried. **Fix:** make `send()` return a success flag and clear `reminder_sent_at` when it is false.

**M6. Cross-tenant reference writes, and `updateBooking` does not notice a no-op update.** `supabase/migrations/0004_floor_plan.sql:11, 23-24, 60-61`, `src/app/actions.ts:204-235` (F2 and F3 above). If the booking id belongs to another tenant, the update matches zero rows with no error, and the code then inserts a `booking_tables` row that links that foreign booking to the owner's table. **Fix:** apply the composite foreign keys in 0005, and have `updateBooking` fail when the update returns no row.

**M7. No security headers on the dashboard.** `next.config.ts:3-5`, `vercel.json`. No `frame-ancestors`/`X-Frame-Options`, no CSP, no HSTS set by the app, so the dashboard and login can be framed (clickjacking of cancel and settings buttons). **Fix:** add a `headers()` block with `Content-Security-Policy: frame-ancestors 'none'` for the dashboard routes only.

**M8. Admin API relies on one shared secret with no throttling.** `src/app/api/admin/restaurants/route.ts:22`. The comparison is not constant-time, there is no rate limit or lockout, and a hit creates a pre-confirmed login. The secret is long locally (48 characters). **Fix:** compare with `crypto.timingSafeEqual`, rate-limit by IP, and restrict `/api/admin` to a network allowlist or a Vercel protection rule.

**M9. Saving the floor plan is not atomic and can destroy another session's work.** `src/app/floor-actions.ts:119-143`. It upserts, then deletes everything not in the payload, with delete errors ignored. A partial failure leaves a half-saved plan, and two people editing at once delete each other's tables, which cascades away their guest assignments. **Fix:** do the whole save in one database function or transaction and add an optimistic version check.

**M10. Double submit creates duplicate bookings.** `public/widget.js:369-383`, `src/app/api/public/bookings/route.ts:86`. A network timeout after the server committed makes the guest retry, which books and emails twice and consumes cap twice. **Fix:** accept a client-generated idempotency key and enforce it with a unique index.

**M11. Guest personal data has no retention or deletion path.** `supabase/migrations/0001_init.sql:65-78`. Name, phone and email are stored indefinitely with no way to delete or anonymize them, and the cancel page shows the name to anyone holding the link. Legal position unverified. **Fix:** add a scheduled job that anonymizes bookings older than the retention period and a delete-guest action.

### Low

**L1. Impossible dates cause 500 errors and a page crash.** `src/app/api/public/bookings/route.ts:51` (`2026-02-31` reaches the database and returns 500), `src/app/(dashboard)/day/page.tsx:59-62` (`?date=2026-99-99` throws `RangeError: Invalid time value`, verified), `src/app/actions.ts:102` (unvalidated date interpolated into a redirect). **Fix:** validate with a real calendar-date parser in one shared helper.

**L2. Error text from the URL is shown as page copy.** `src/app/login/page.tsx:26-28`, `src/app/(dashboard)/page.tsx:100-104`. React escapes it, but an attacker can craft a link that shows convincing text inside your login page. **Fix:** map a short error code to a fixed message.

**L3. `anon` and `authenticated` hold TRUNCATE, TRIGGER and REFERENCES on all eight tables.** Confirmed on staging; not reachable through PostgREST. **Fix:** `revoke truncate, trigger, references on all tables in schema public from anon, authenticated`.

**L4. Cancelling from the dashboard emails the guest every time it is called.** `src/app/actions.ts:78-85`. A double click, or repeating the action on an already-cancelled booking, sends duplicates. **Fix:** only send when the previous status was `confirmed`.

**L5. Only the first owner is notified.** `src/app/api/public/bookings/route.ts:119`, `src/app/cancel/[token]/page.tsx:108`. `limit(1)` with no ordering; multi-owner restaurants are impossible today (one user, one restaurant), but the lookup is arbitrary. **Fix:** order by `created_at` or store a notification address on `restaurants`.

**L6. The upcoming-bookings list is unbounded and its stats are truncated.** `src/app/(dashboard)/page.tsx:28-41`. The past view is limited to 200, the upcoming view has no limit, and the counts silently stop at the API row cap. **Fix:** paginate and use count queries.

**L7. The proxy matcher excludes by prefix.** `src/proxy.ts:55`. `admin` and `cancel` have no trailing boundary, so a future route such as `/admin-tools` or `/cancelled` would silently skip the login gate. **Fix:** anchor each exclusion with `(?:/|$)`.

**L8. Admin form shows the owner password in clear text and the API stores unchecked hours.** `src/app/admin/page.tsx:122`, `src/app/api/admin/restaurants/route.ts:65`. **Fix:** use `type="password"` and validate `operatingHours` with the same rules as `saveSettings`.

**L9. One shared sender, no reply-to, and a hard-coded production URL.** `src/lib/email.ts:7-8, 57`. Guests who reply to a confirmation reach nobody, and a staging deployment without `NEXT_PUBLIC_APP_URL` puts production cancel links in its emails. **Fix:** set `reply_to` to the restaurant's address and fail loudly when `NEXT_PUBLIC_APP_URL` is missing.

**L10. Party-size limits disagree.** `src/lib/types.ts:115` (12 online) versus `supabase/migrations/0001_init.sql:71` (50) and the walk-in clamp (50). A party larger than the slot cap shows "fully booked" instead of "call us". **Fix:** show a "large party, contact us" message above the cap.

**L11. Per-day cap overrides are saved by delete-then-insert without a transaction.** `src/app/actions.ts:298-322`. A failed insert leaves the day with no override and falls back to the default silently. **Fix:** use a single upsert on the unique scope index.

## 6. What to do first

1. Apply the 0005 fixes to staging, re-run `npm run test:rls`, then to production (C1, M6).
2. Put a rate limit and bot check in front of `POST /api/public/bookings` (H1).
3. Upgrade Next.js (H2) and fix the local environment file (H3).
4. Close the cron and sign-up gaps (M1, M2).

## 7. Method

Read in full: all four migrations and the seed, every API route, both server-action files, `src/lib` (supabase clients, availability, email, cors, types), `src/proxy.ts`, the login, admin and cancel pages, the dashboard layout, the bookings list and the day page (first 140 lines), `public/widget.js`, `vercel.json`, `next.config.ts`, `package.json`, the README, and the RLS test harness. Only grepped, not read line by line: the settings, new-booking and edit-booking pages, the floor-plan page and editor, the floor map and walk-in components, and the translation file (`src/lib/i18n.ts`). A bug that lives only in those files would be missed. Ran the existing staging-only RLS suite, read-only catalog queries on staging, `npm audit --omit=dev`, and a local check of the date edge cases. Did not read `.env.local` values (only variable names, secret lengths and the Supabase project ref), and did not connect to the project that file points at.
