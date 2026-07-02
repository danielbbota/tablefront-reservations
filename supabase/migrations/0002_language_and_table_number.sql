-- Language per restaurant (dashboard, widget and guest emails) and
-- free-text table number on bookings.

alter table public.restaurants
  add column language text not null default 'en'
  check (language in ('en', 'pt', 'de', 'fr'));

alter table public.bookings
  add column table_number text;
