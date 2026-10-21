-- =============================================================================
-- PROPOSED — NOT APPLIED. Fixes the tenant-isolation gaps found by
-- `npm run test:rls` (tests/rls). Review, then move this file to
-- supabase/migrations/0005_tenant_isolation_fixes.sql and apply to STAGING
-- first, re-run `npm run test:rls`, and only then apply to production.
--
-- Findings it fixes
--   F1  create_widget_booking() is callable by anon and authenticated.
--       0001/0003 revoked EXECUTE from anon/authenticated, but PostgreSQL also
--       grants EXECUTE on every new function to PUBLIC, and that grant was
--       never revoked — so anon/authenticated still inherit it. The function is
--       SECURITY DEFINER (runs as postgres, bypasses RLS) and takes the cover
--       cap from the caller, so anyone with the public anon key can insert
--       confirmed bookings into ANY restaurant and bypass capacity.
--   F2  floor_tables / floor_elements: zone_id may point at another tenant's
--       zone (RLS only checks restaurant_id).
--   F3  booking_tables: booking_id / table_id may point at another tenant's
--       booking or table (RLS only checks restaurant_id).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- F1. Lock the SECURITY DEFINER booking function down to service_role.
--     The widget API (src/app/api/public/bookings/route.ts) calls it with the
--     service-role key, so nothing else needs EXECUTE.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_widget_booking(
  uuid, date, time, int, text, text, text, text, int, text
) from public, anon, authenticated;

grant execute on function public.create_widget_booking(
  uuid, date, time, int, text, text, text, text, int, text
) to service_role;

-- my_restaurant_id() is evaluated inside every RLS policy, so anon and
-- authenticated must be able to call it (it returns NULL without a JWT, which
-- makes every policy false). Make that explicit instead of relying on PUBLIC.
revoke execute on function public.my_restaurant_id() from public;
grant execute on function public.my_restaurant_id() to anon, authenticated, service_role;

-- Optional hardening: stop PostgreSQL from handing EXECUTE on future functions
-- in public to PUBLIC. (Supabase's own default privileges for anon /
-- authenticated / service_role are unaffected; new functions must still get
-- explicit grants/revokes.)
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- F2 + F3. Tenant-scoped composite foreign keys. A child row's restaurant_id
-- must equal the parent row's restaurant_id — enforced for every role,
-- including service_role, not just through RLS.
-- ---------------------------------------------------------------------------

-- Pre-flight: refuse to run if cross-tenant rows already exist (clean them first).
do $$
begin
  if exists (
    select 1 from public.floor_tables t join public.floor_zones z on z.id = t.zone_id
    where z.restaurant_id <> t.restaurant_id
  ) then raise exception 'floor_tables has rows whose zone belongs to another restaurant';
  end if;

  if exists (
    select 1 from public.floor_elements e join public.floor_zones z on z.id = e.zone_id
    where z.restaurant_id <> e.restaurant_id
  ) then raise exception 'floor_elements has rows whose zone belongs to another restaurant';
  end if;

  if exists (
    select 1 from public.booking_tables bt join public.bookings b on b.id = bt.booking_id
    where b.restaurant_id <> bt.restaurant_id
  ) then raise exception 'booking_tables has rows whose booking belongs to another restaurant';
  end if;

  if exists (
    select 1 from public.booking_tables bt join public.floor_tables t on t.id = bt.table_id
    where t.restaurant_id <> bt.restaurant_id
  ) then raise exception 'booking_tables has rows whose table belongs to another restaurant';
  end if;
end $$;

-- Composite FK targets (id is already the PK; the pair is needed as an FK target).
alter table public.floor_zones  add constraint floor_zones_id_restaurant_id_key  unique (id, restaurant_id);
alter table public.floor_tables add constraint floor_tables_id_restaurant_id_key unique (id, restaurant_id);
alter table public.bookings     add constraint bookings_id_restaurant_id_key     unique (id, restaurant_id);

-- floor_tables.zone_id -> same-tenant zone
alter table public.floor_tables
  drop constraint floor_tables_zone_id_fkey,
  add constraint floor_tables_zone_id_fkey
    foreign key (zone_id, restaurant_id)
    references public.floor_zones (id, restaurant_id) on delete cascade;

-- floor_elements.zone_id -> same-tenant zone
alter table public.floor_elements
  drop constraint floor_elements_zone_id_fkey,
  add constraint floor_elements_zone_id_fkey
    foreign key (zone_id, restaurant_id)
    references public.floor_zones (id, restaurant_id) on delete cascade;

-- booking_tables.booking_id / table_id -> same-tenant booking and table
alter table public.booking_tables
  drop constraint booking_tables_booking_id_fkey,
  add constraint booking_tables_booking_id_fkey
    foreign key (booking_id, restaurant_id)
    references public.bookings (id, restaurant_id) on delete cascade,
  drop constraint booking_tables_table_id_fkey,
  add constraint booking_tables_table_id_fkey
    foreign key (table_id, restaurant_id)
    references public.floor_tables (id, restaurant_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Verification after applying (expected results in comments):
-- select proacl from pg_proc where proname = 'create_widget_booking';
--   -> {postgres=X/postgres,service_role=X/postgres}   (no "=X/" PUBLIC entry)
-- npm run test:rls   -> all checks pass
-- ---------------------------------------------------------------------------
