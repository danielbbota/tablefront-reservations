-- TableFront Reservations — initial schema
-- Run via Supabase SQL editor or `supabase db push`.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- restaurants
-- operating_hours: JSON keyed by day-of-week ("0" = Sunday … "6" = Saturday),
--   each value { "open": "18:00", "close": "22:00", "closed": false }
-- ---------------------------------------------------------------------------
create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'Europe/Lisbon',
  slot_interval_minutes int not null default 30 check (slot_interval_minutes between 15 and 120),
  operating_hours jsonb not null default '{}'::jsonb,
  default_max_covers int not null default 20 check (default_max_covers >= 0),
  brand jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- owners — one row per dashboard user, keyed to auth.users
-- ---------------------------------------------------------------------------
create table public.owners (
  id uuid primary key references auth.users (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create index owners_restaurant_id_idx on public.owners (restaurant_id);

-- ---------------------------------------------------------------------------
-- capacity_rules — overrides for the online-booking cover cap.
-- Resolution (most specific wins):
--   specific_date + time_slot > specific_date > day_of_week + time_slot
--   > day_of_week > restaurants.default_max_covers
-- V1 UI only edits day_of_week rows; the rest are supported for later.
-- ---------------------------------------------------------------------------
create table public.capacity_rules (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  day_of_week int check (day_of_week between 0 and 6),
  specific_date date,
  time_slot time,
  max_covers int not null check (max_covers >= 0),
  created_at timestamptz not null default now(),
  check (day_of_week is not null or specific_date is not null)
);

create index capacity_rules_restaurant_idx on public.capacity_rules (restaurant_id);
create unique index capacity_rules_unique_scope
  on public.capacity_rules (
    restaurant_id,
    coalesce(day_of_week, -1),
    coalesce(specific_date, 'epoch'::date),
    coalesce(time_slot, '00:00'::time)
  );

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  guest_name text not null,
  guest_phone text not null,
  guest_email text not null,
  party_size int not null check (party_size between 1 and 50),
  date date not null,
  time_slot time not null,
  notes text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  source text not null default 'widget' check (source in ('widget', 'manual')),
  created_at timestamptz not null default now()
);

create index bookings_restaurant_date_idx on public.bookings (restaurant_id, date, time_slot);

-- ---------------------------------------------------------------------------
-- Row Level Security — tenant isolation enforced at the query layer.
-- The public widget API and admin API use the service-role key server-side;
-- anon has no direct table access at all.
-- ---------------------------------------------------------------------------
alter table public.restaurants enable row level security;
alter table public.owners enable row level security;
alter table public.capacity_rules enable row level security;
alter table public.bookings enable row level security;

create or replace function public.my_restaurant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select restaurant_id from public.owners where id = auth.uid()
$$;

create policy "owners read own row"
  on public.owners for select
  using (id = auth.uid());

create policy "owners read own restaurant"
  on public.restaurants for select
  using (id = public.my_restaurant_id());

create policy "owners update own restaurant"
  on public.restaurants for update
  using (id = public.my_restaurant_id())
  with check (id = public.my_restaurant_id());

create policy "owners manage own capacity rules"
  on public.capacity_rules for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own bookings"
  on public.bookings for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

-- ---------------------------------------------------------------------------
-- Atomic widget booking: check the cover cap and insert under an advisory
-- lock so two concurrent guests cannot both grab the last covers of a slot.
-- p_max_covers is resolved by the API from capacity_rules; the cap counts
-- ALL confirmed covers (widget + manual). Called with the service-role key.
-- ---------------------------------------------------------------------------
create or replace function public.create_widget_booking(
  p_restaurant_id uuid,
  p_date date,
  p_time_slot time,
  p_party_size int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_max_covers int
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booked int;
  v_row public.bookings;
begin
  perform pg_advisory_xact_lock(
    hashtext(p_restaurant_id::text || p_date::text || p_time_slot::text)
  );

  select coalesce(sum(party_size), 0) into v_booked
  from public.bookings
  where restaurant_id = p_restaurant_id
    and date = p_date
    and time_slot = p_time_slot
    and status = 'confirmed';

  if v_booked + p_party_size > p_max_covers then
    raise exception 'SLOT_FULL' using errcode = 'P0001';
  end if;

  insert into public.bookings
    (restaurant_id, guest_name, guest_phone, guest_email, party_size,
     date, time_slot, notes, status, source)
  values
    (p_restaurant_id, p_guest_name, p_guest_phone, p_guest_email, p_party_size,
     p_date, p_time_slot, p_notes, 'confirmed', 'widget')
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_widget_booking from anon, authenticated;
revoke execute on function public.my_restaurant_id from anon;
