-- =============================================================================
-- 0006 — Multi-vertical platform.
--
-- Adds two products next to the original restaurant one, on the same tenant
-- table (public.restaurants stays the "business" table; renaming it would
-- break the live app for no gain):
--
--   stays         hotels, guesthouses, holiday rentals: units, nightly rates,
--                 reservations, date blocks and iCal channel feeds
--                 (Airbnb / Booking.com / Vrbo).
--   appointments  clinics, barbers, salons: services, staff, staff working
--                 hours / time off and timed appointments.
--
-- Plus optional online payment (deposit or full amount) for both.
--
-- Safe to run on a database that only has restaurants: every existing row
-- becomes business_type = 'restaurant' and nothing else changes for it.
--
-- (This file does not depend on 0005_tenant_isolation_fixes.sql, but follows
-- its two lessons from day one:
-- SECURITY DEFINER functions are granted to service_role only, and every
-- child row is tied to its parent's tenant with a composite foreign key.)
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Business type + shared settings
-- ---------------------------------------------------------------------------
alter table public.restaurants
  add column business_type text not null default 'restaurant'
    check (business_type in ('restaurant', 'stays', 'appointments')),
  add column currency text not null default 'EUR'
    check (currency ~ '^[A-Z]{3}$'),
  -- Online payment at booking time: none, a percentage deposit, or everything.
  add column payment_mode text not null default 'none'
    check (payment_mode in ('none', 'deposit', 'full')),
  add column deposit_percent int not null default 30
    check (deposit_percent between 1 and 100),
  -- Stays only.
  add column check_in_time time not null default '15:00',
  add column check_out_time time not null default '11:00';

-- Owners may edit their own business row (0001), but the product they are on
-- is decided by TableFront at onboarding, not by a PATCH from the browser.
create or replace function public.restaurants_guard_business_type()
returns trigger
language plpgsql
as $$
begin
  if new.business_type is distinct from old.business_type
     and current_user in ('authenticated', 'anon') then
    raise exception 'business_type can only be changed by TableFront'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger restaurants_guard_business_type
  before update on public.restaurants
  for each row execute function public.restaurants_guard_business_type();

-- ---------------------------------------------------------------------------
-- payment_accounts — the business's connected Stripe account.
-- Read-only for owners: only the server (service role) writes it, so an owner
-- cannot point their bookings at somebody else's Stripe account.
-- ---------------------------------------------------------------------------
create table public.payment_accounts (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.payment_accounts enable row level security;

create policy "owners read own payment account"
  on public.payment_accounts for select
  using (restaurant_id = public.my_restaurant_id());

-- =============================================================================
-- STAYS
-- =============================================================================

-- One row per physical bookable unit (a room, an apartment, a villa).
create table public.stay_units (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  max_guests int not null default 2 check (max_guests between 1 and 30),
  base_price_cents int not null default 0 check (base_price_cents >= 0),
  cleaning_fee_cents int not null default 0 check (cleaning_fee_cents >= 0),
  min_nights int not null default 1 check (min_nights between 1 and 90),
  sort int not null default 0,
  active boolean not null default true,
  -- Credential of this unit's outgoing iCal feed (/api/public/ical/<token>).
  ical_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  unique (id, restaurant_id)
);

create index stay_units_restaurant_idx on public.stay_units (restaurant_id);
create unique index stay_units_ical_token_idx on public.stay_units (ical_token);

-- Seasonal price overrides. start_date and end_date are both inclusive nights.
create table public.stay_rates (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  unit_id uuid not null,
  start_date date not null,
  end_date date not null,
  price_cents int not null check (price_cents >= 0),
  min_nights int check (min_nights between 1 and 90),
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  foreign key (unit_id, restaurant_id)
    references public.stay_units (id, restaurant_id) on delete cascade
);

create index stay_rates_unit_idx on public.stay_rates (unit_id, start_date);

-- Incoming channel calendars. Each feed belongs to one unit.
create table public.stay_ical_feeds (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  unit_id uuid not null,
  channel text not null check (channel in ('airbnb', 'booking', 'vrbo', 'other')),
  url text not null check (url ~ '^https://' and length(url) <= 2000),
  last_synced_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_error text,
  created_at timestamptz not null default now(),
  unique (id, restaurant_id),
  unique (unit_id, url),
  foreign key (unit_id, restaurant_id)
    references public.stay_units (id, restaurant_id) on delete cascade
);

create index stay_ical_feeds_restaurant_idx on public.stay_ical_feeds (restaurant_id);

-- check_out is exclusive: a stay occupies the nights [check_in, check_out).
create table public.stay_reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  unit_id uuid not null,
  check_in date not null,
  check_out date not null,
  guests int not null default 1 check (guests between 1 and 30),
  guest_name text not null,
  guest_phone text not null default '',
  guest_email text not null default '',
  notes text,
  status text not null default 'confirmed'
    check (status in ('pending_payment', 'confirmed', 'cancelled')),
  -- widget / manual are direct bookings; the rest arrive through an iCal feed.
  source text not null default 'widget'
    check (source in ('widget', 'manual', 'airbnb', 'booking', 'vrbo', 'other')),
  feed_id uuid,
  external_uid text,
  external_ref text,
  stay_status text check (stay_status in ('checked_in', 'checked_out', 'no_show')),
  total_cents int not null default 0 check (total_cents >= 0),
  amount_due_cents int not null default 0 check (amount_due_cents >= 0),
  paid_cents int not null default 0 check (paid_cents >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  payment_status text not null default 'none'
    check (payment_status in ('none', 'pending', 'paid', 'refunded')),
  stripe_session_id text,
  -- While status = 'pending_payment' the dates are held until this instant.
  hold_expires_at timestamptz,
  guest_lang text not null default 'en' check (guest_lang in ('en', 'pt', 'de', 'fr')),
  cancel_token uuid not null default gen_random_uuid(),
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (check_out > check_in),
  unique (id, restaurant_id),
  foreign key (unit_id, restaurant_id)
    references public.stay_units (id, restaurant_id) on delete cascade,
  -- Removing a feed removes what it imported: an un-syncable phantom
  -- reservation would block the unit forever.
  foreign key (feed_id, restaurant_id)
    references public.stay_ical_feeds (id, restaurant_id) on delete cascade
);

create index stay_reservations_restaurant_idx on public.stay_reservations (restaurant_id, check_in);
create index stay_reservations_unit_idx on public.stay_reservations (unit_id, check_in, check_out);
create unique index stay_reservations_cancel_token_idx on public.stay_reservations (cancel_token);
create unique index stay_reservations_feed_uid_idx
  on public.stay_reservations (feed_id, external_uid)
  where feed_id is not null;
create index stay_reservations_stripe_session_idx
  on public.stay_reservations (stripe_session_id)
  where stripe_session_id is not null;

-- Owner-made date blocks (maintenance, own use). end_date is exclusive.
create table public.stay_blocks (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  unit_id uuid not null,
  start_date date not null,
  end_date date not null,
  reason text,
  created_at timestamptz not null default now(),
  check (end_date > start_date),
  foreign key (unit_id, restaurant_id)
    references public.stay_units (id, restaurant_id) on delete cascade
);

create index stay_blocks_unit_idx on public.stay_blocks (unit_id, start_date, end_date);

-- =============================================================================
-- APPOINTMENTS
-- =============================================================================

create table public.services (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  category text,
  description text,
  duration_minutes int not null check (duration_minutes between 5 and 480),
  -- Clean-up / preparation time kept free after the service.
  buffer_minutes int not null default 0 check (buffer_minutes between 0 and 120),
  price_cents int not null default 0 check (price_cents >= 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, restaurant_id)
);

create index services_restaurant_idx on public.services (restaurant_id);

-- working_hours: same shape as restaurants.operating_hours ("0" = Sunday …),
-- or null to follow the business's opening hours.
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  title text,
  color text not null default '#c9954a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  working_hours jsonb,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (id, restaurant_id)
);

create index staff_restaurant_idx on public.staff (restaurant_id);

-- Which professional performs which service.
create table public.staff_services (
  staff_id uuid not null,
  service_id uuid not null,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  primary key (staff_id, service_id),
  foreign key (staff_id, restaurant_id)
    references public.staff (id, restaurant_id) on delete cascade,
  foreign key (service_id, restaurant_id)
    references public.services (id, restaurant_id) on delete cascade
);

create index staff_services_service_idx on public.staff_services (service_id);
create index staff_services_restaurant_idx on public.staff_services (restaurant_id);

-- Holidays, breaks, blocked time. Null times = the whole day.
create table public.staff_time_off (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  staff_id uuid not null,
  date date not null,
  start_time time,
  end_time time,
  reason text,
  created_at timestamptz not null default now(),
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or end_time > start_time),
  foreign key (staff_id, restaurant_id)
    references public.staff (id, restaurant_id) on delete cascade
);

create index staff_time_off_staff_idx on public.staff_time_off (staff_id, date);

-- service_name / duration / price are snapshots taken at booking time, so
-- editing or deleting a service never rewrites history.
-- busy_until = end_time + the service's buffer: the professional is free again
-- from that time on.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  service_id uuid,
  staff_id uuid not null,
  date date not null,
  start_time time not null,
  end_time time not null,
  busy_until time not null,
  service_name text not null,
  duration_minutes int not null check (duration_minutes between 5 and 480),
  price_cents int not null default 0 check (price_cents >= 0),
  guest_name text not null,
  guest_phone text not null default '',
  guest_email text not null default '',
  notes text,
  status text not null default 'confirmed'
    check (status in ('pending_payment', 'confirmed', 'cancelled')),
  source text not null default 'widget' check (source in ('widget', 'manual')),
  service_status text check (service_status in ('arrived', 'completed', 'no_show')),
  amount_due_cents int not null default 0 check (amount_due_cents >= 0),
  paid_cents int not null default 0 check (paid_cents >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  payment_status text not null default 'none'
    check (payment_status in ('none', 'pending', 'paid', 'refunded')),
  stripe_session_id text,
  hold_expires_at timestamptz,
  guest_lang text not null default 'en' check (guest_lang in ('en', 'pt', 'de', 'fr')),
  cancel_token uuid not null default gen_random_uuid(),
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check (busy_until >= end_time),
  unique (id, restaurant_id),
  foreign key (service_id, restaurant_id)
    references public.services (id, restaurant_id) on delete set null (service_id),
  -- No cascade on purpose: a professional with appointments is deactivated,
  -- not deleted.
  foreign key (staff_id, restaurant_id)
    references public.staff (id, restaurant_id)
);

create index appointments_restaurant_date_idx on public.appointments (restaurant_id, date, start_time);
create index appointments_staff_date_idx on public.appointments (staff_id, date);
create unique index appointments_cancel_token_idx on public.appointments (cancel_token);
create index appointments_stripe_session_idx
  on public.appointments (stripe_session_id)
  where stripe_session_id is not null;

-- =============================================================================
-- Row Level Security — same tenant isolation as every other table.
-- =============================================================================
alter table public.stay_units enable row level security;
alter table public.stay_rates enable row level security;
alter table public.stay_ical_feeds enable row level security;
alter table public.stay_reservations enable row level security;
alter table public.stay_blocks enable row level security;
alter table public.services enable row level security;
alter table public.staff enable row level security;
alter table public.staff_services enable row level security;
alter table public.staff_time_off enable row level security;
alter table public.appointments enable row level security;

create policy "owners manage own stay units"
  on public.stay_units for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own stay rates"
  on public.stay_rates for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own stay ical feeds"
  on public.stay_ical_feeds for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own stay reservations"
  on public.stay_reservations for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own stay blocks"
  on public.stay_blocks for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own services"
  on public.services for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own staff"
  on public.staff for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own staff services"
  on public.staff_services for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own staff time off"
  on public.staff_time_off for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own appointments"
  on public.appointments for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

-- =============================================================================
-- Atomic booking functions (service role only).
-- =============================================================================

-- Reserve a unit for [p_check_in, p_check_out) unless any live reservation or
-- block overlaps. "Live" = confirmed, or awaiting payment with an unexpired
-- hold. One advisory lock per unit serialises concurrent guests.
-- p_hold_minutes > 0 creates a pending_payment hold instead of a confirmation.
create or replace function public.create_stay_reservation(
  p_restaurant_id uuid,
  p_unit_id uuid,
  p_check_in date,
  p_check_out date,
  p_guests int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_source text,
  p_guest_lang text,
  p_total_cents int,
  p_amount_due_cents int,
  p_currency text,
  p_hold_minutes int
)
returns public.stay_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stay_reservations;
  v_hold boolean := coalesce(p_hold_minutes, 0) > 0;
begin
  perform pg_advisory_xact_lock(hashtext('stay:' || p_unit_id::text));

  if not exists (
    select 1 from public.stay_units
    where id = p_unit_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'UNIT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.stay_reservations r
    where r.unit_id = p_unit_id
      and r.check_in < p_check_out
      and r.check_out > p_check_in
      and (r.status = 'confirmed'
           or (r.status = 'pending_payment' and r.hold_expires_at > now()))
  ) or exists (
    select 1 from public.stay_blocks b
    where b.unit_id = p_unit_id
      and b.start_date < p_check_out
      and b.end_date > p_check_in
  ) then
    raise exception 'DATES_TAKEN' using errcode = 'P0001';
  end if;

  insert into public.stay_reservations
    (restaurant_id, unit_id, check_in, check_out, guests,
     guest_name, guest_phone, guest_email, notes,
     status, source, guest_lang,
     total_cents, amount_due_cents, currency, payment_status, hold_expires_at)
  values
    (p_restaurant_id, p_unit_id, p_check_in, p_check_out, p_guests,
     p_guest_name, coalesce(p_guest_phone, ''), coalesce(p_guest_email, ''), p_notes,
     case when v_hold then 'pending_payment' else 'confirmed' end,
     case when p_source = 'manual' then 'manual' else 'widget' end,
     case when p_guest_lang in ('en', 'pt', 'de', 'fr') then p_guest_lang else 'en' end,
     greatest(coalesce(p_total_cents, 0), 0),
     case when v_hold then greatest(coalesce(p_amount_due_cents, 0), 0) else 0 end,
     coalesce(p_currency, 'EUR'),
     case when v_hold then 'pending' else 'none' end,
     case when v_hold then now() + make_interval(mins => p_hold_minutes) else null end)
  returning * into v_row;

  return v_row;
end;
$$;

-- Book a professional for [p_start_time, p_busy_until) on a date unless a live
-- appointment of theirs overlaps. One advisory lock per professional and day.
create or replace function public.create_appointment(
  p_restaurant_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time,
  p_busy_until time,
  p_service_name text,
  p_duration_minutes int,
  p_price_cents int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_source text,
  p_guest_lang text,
  p_amount_due_cents int,
  p_currency text,
  p_hold_minutes int
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.appointments;
  v_hold boolean := coalesce(p_hold_minutes, 0) > 0;
begin
  perform pg_advisory_xact_lock(hashtext('appt:' || p_staff_id::text || p_date::text));

  if not exists (
    select 1 from public.staff
    where id = p_staff_id and restaurant_id = p_restaurant_id
  ) then
    raise exception 'STAFF_NOT_FOUND' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.appointments a
    where a.staff_id = p_staff_id
      and a.date = p_date
      and a.start_time < p_busy_until
      and a.busy_until > p_start_time
      and (a.status = 'confirmed'
           or (a.status = 'pending_payment' and a.hold_expires_at > now()))
  ) then
    raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end if;

  insert into public.appointments
    (restaurant_id, service_id, staff_id, date, start_time, end_time, busy_until,
     service_name, duration_minutes, price_cents,
     guest_name, guest_phone, guest_email, notes,
     status, source, guest_lang,
     amount_due_cents, currency, payment_status, hold_expires_at)
  values
    (p_restaurant_id, p_service_id, p_staff_id, p_date, p_start_time, p_end_time, p_busy_until,
     p_service_name, p_duration_minutes, greatest(coalesce(p_price_cents, 0), 0),
     p_guest_name, coalesce(p_guest_phone, ''), coalesce(p_guest_email, ''), p_notes,
     case when v_hold then 'pending_payment' else 'confirmed' end,
     case when p_source = 'manual' then 'manual' else 'widget' end,
     case when p_guest_lang in ('en', 'pt', 'de', 'fr') then p_guest_lang else 'en' end,
     case when v_hold then greatest(coalesce(p_amount_due_cents, 0), 0) else 0 end,
     coalesce(p_currency, 'EUR'),
     case when v_hold then 'pending' else 'none' end,
     case when v_hold then now() + make_interval(mins => p_hold_minutes) else null end)
  returning * into v_row;

  return v_row;
end;
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC; take it back.
revoke execute on function public.create_stay_reservation(
  uuid, uuid, date, date, int, text, text, text, text, text, text, int, int, text, int
) from public, anon, authenticated;
grant execute on function public.create_stay_reservation(
  uuid, uuid, date, date, int, text, text, text, text, text, text, int, int, text, int
) to service_role;

revoke execute on function public.create_appointment(
  uuid, uuid, uuid, date, time, time, time, text, int, int, text, text, text, text, text, text, int, text, int
) from public, anon, authenticated;
grant execute on function public.create_appointment(
  uuid, uuid, uuid, date, time, time, time, text, int, int, text, text, text, text, text, text, int, text, int
) to service_role;

-- ---------------------------------------------------------------------------
-- Verification after applying:
--   select business_type, count(*) from public.restaurants group by 1;
--     -> every existing row is 'restaurant'
--   select proname, proacl from pg_proc
--     where proname in ('create_stay_reservation', 'create_appointment');
--     -> no "=X/" PUBLIC entry, service_role=X present
-- ---------------------------------------------------------------------------
