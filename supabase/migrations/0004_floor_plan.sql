-- Interactive floor plan: zones, tables, scenery elements, booking↔table
-- assignments, and the turn-time setting that models how long a party
-- occupies a table.

alter table public.restaurants
  add column turn_time_minutes int not null default 90
    check (turn_time_minutes between 30 and 360);

create table public.floor_zones (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create index floor_zones_restaurant_idx on public.floor_zones (restaurant_id);

-- Coordinate space: 1000 × 700 units per zone (rendered as an SVG viewBox).
create table public.floor_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  zone_id uuid not null references public.floor_zones (id) on delete cascade,
  name text not null,
  seats int not null check (seats between 1 and 30),
  shape text not null default 'rect' check (shape in ('rect', 'round')),
  x real not null,
  y real not null,
  w real not null,
  h real not null,
  rotation real not null default 0,
  -- Tables sharing a non-null group can be physically joined for large
  -- parties (used later by table-aware availability).
  combinable_group text,
  created_at timestamptz not null default now()
);

create index floor_tables_restaurant_idx on public.floor_tables (restaurant_id);
create index floor_tables_zone_idx on public.floor_tables (zone_id);

-- Non-functional scenery so the map reads like the actual room.
create table public.floor_elements (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  zone_id uuid not null references public.floor_zones (id) on delete cascade,
  kind text not null check (kind in ('wall', 'bar', 'door', 'plant', 'label')),
  label text,
  x real not null,
  y real not null,
  w real not null,
  h real not null,
  rotation real not null default 0,
  created_at timestamptz not null default now()
);

create index floor_elements_zone_idx on public.floor_elements (zone_id);

-- A booking can span multiple joined tables.
create table public.booking_tables (
  booking_id uuid not null references public.bookings (id) on delete cascade,
  table_id uuid not null references public.floor_tables (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  primary key (booking_id, table_id)
);

create index booking_tables_table_idx on public.booking_tables (table_id);
create index booking_tables_restaurant_idx on public.booking_tables (restaurant_id);

-- RLS: same tenant isolation as everything else.
alter table public.floor_zones enable row level security;
alter table public.floor_tables enable row level security;
alter table public.floor_elements enable row level security;
alter table public.booking_tables enable row level security;

create policy "owners manage own floor zones"
  on public.floor_zones for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own floor tables"
  on public.floor_tables for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own floor elements"
  on public.floor_elements for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());

create policy "owners manage own booking tables"
  on public.booking_tables for all
  using (restaurant_id = public.my_restaurant_id())
  with check (restaurant_id = public.my_restaurant_id());
