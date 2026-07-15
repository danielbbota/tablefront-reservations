-- Guest language (emails follow the language the guest booked in),
-- tokenized self-serve cancellation, reminder tracking, and
-- day-of-service status (arrived / seated / no-show).

alter table public.bookings
  add column guest_lang text not null default 'en'
    check (guest_lang in ('en', 'pt', 'de', 'fr')),
  add column cancel_token uuid not null default gen_random_uuid(),
  add column reminder_sent_at timestamptz,
  add column service_status text
    check (service_status in ('arrived', 'seated', 'no_show'));

create unique index bookings_cancel_token_idx on public.bookings (cancel_token);

-- Recreate the widget booking function with the guest's language.
-- (Dropped first: create or replace with a new parameter list would
-- otherwise create a second overload.)
drop function if exists public.create_widget_booking(
  uuid, date, time, int, text, text, text, text, int
);

create or replace function public.create_widget_booking(
  p_restaurant_id uuid,
  p_date date,
  p_time_slot time,
  p_party_size int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_max_covers int,
  p_guest_lang text
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
     date, time_slot, notes, status, source, guest_lang)
  values
    (p_restaurant_id, p_guest_name, p_guest_phone, p_guest_email, p_party_size,
     p_date, p_time_slot, p_notes, 'confirmed', 'widget',
     case when p_guest_lang in ('en','pt','de','fr') then p_guest_lang else 'en' end)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_widget_booking from anon, authenticated;
