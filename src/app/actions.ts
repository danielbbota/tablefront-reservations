'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendGuestCancellation } from '@/lib/email';
import type { Booking, BookingStatus, OperatingHours, Restaurant } from '@/lib/types';

/**
 * All dashboard reads/writes go through the cookie-based client, so RLS
 * scopes every query to the logged-in owner's restaurant. The service-role
 * client is only used to read the restaurant for the cancellation email.
 *
 * Form-bound actions return void; feedback flows via redirect query params.
 */

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function login(formData: FormData) {
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  });
  if (error) fail('/login', 'Invalid email or password');
  redirect('/');
}

export async function logout() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect('/login');
}

export async function setBookingStatus(bookingId: string, status: BookingStatus) {
  const supabase = await createServerSupabase();
  const { data: booking, error } = await supabase
    .from('bookings')
    .update({ status })
    .eq('id', bookingId) // RLS restricts this to the owner's restaurant
    .select()
    .single<Booking>();

  if (error || !booking) fail('/', 'Could not update the booking.');

  if (status === 'cancelled') {
    const { data: restaurant } = await createAdminClient()
      .from('restaurants')
      .select('*')
      .eq('id', booking.restaurant_id)
      .single<Restaurant>();
    if (restaurant) await sendGuestCancellation(restaurant, booking);
  }

  revalidatePath('/');
}

export async function createManualBooking(formData: FormData) {
  const supabase = await createServerSupabase();

  const { data: owner } = await supabase
    .from('owners')
    .select('restaurant_id')
    .single<{ restaurant_id: string }>();
  if (!owner) fail('/bookings/new', 'Not logged in.');

  const partySize = Number(formData.get('partySize'));
  const date = String(formData.get('date') ?? '');
  const time = String(formData.get('time') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (!name) fail('/bookings/new', 'Guest name is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('/bookings/new', 'A date is required.');
  if (!/^\d{2}:\d{2}$/.test(time)) fail('/bookings/new', 'A time is required.');
  if (!Number.isInteger(partySize) || partySize < 1)
    fail('/bookings/new', 'Invalid party size.');

  // Manual bookings deliberately skip the online capacity cap — the cap only
  // throttles the self-serve widget.
  const { error } = await supabase.from('bookings').insert({
    restaurant_id: owner.restaurant_id,
    guest_name: name,
    guest_phone: String(formData.get('phone') ?? '').trim(),
    guest_email: String(formData.get('email') ?? '').trim(),
    party_size: partySize,
    date,
    time_slot: time,
    notes: String(formData.get('notes') ?? '').trim() || null,
    table_number: String(formData.get('table') ?? '').trim() || null,
    status: 'confirmed',
    source: 'manual',
  });

  if (error) fail('/bookings/new', `Could not create the booking: ${error.message}`);

  revalidatePath('/');
  redirect('/');
}

export async function updateBooking(bookingId: string, formData: FormData) {
  const supabase = await createServerSupabase();
  const back = `/bookings/${bookingId}/edit`;

  const partySize = Number(formData.get('partySize'));
  const date = String(formData.get('date') ?? '');
  const time = String(formData.get('time') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (!name) fail(back, 'Guest name is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(back, 'A date is required.');
  if (!/^\d{2}:\d{2}$/.test(time)) fail(back, 'A time is required.');
  if (!Number.isInteger(partySize) || partySize < 1) fail(back, 'Invalid party size.');

  // Owner edits are trusted like manual bookings: no capacity cap check.
  // RLS restricts the update to the owner's own restaurant.
  const { error } = await supabase
    .from('bookings')
    .update({
      guest_name: name,
      guest_phone: String(formData.get('phone') ?? '').trim(),
      guest_email: String(formData.get('email') ?? '').trim(),
      party_size: partySize,
      date,
      time_slot: time,
      notes: String(formData.get('notes') ?? '').trim() || null,
      table_number: String(formData.get('table') ?? '').trim() || null,
    })
    .eq('id', bookingId);

  if (error) fail(back, `Could not update the booking: ${error.message}`);

  revalidatePath('/');
  redirect('/');
}

export async function saveSettings(formData: FormData) {
  const supabase = await createServerSupabase();

  const { data: owner } = await supabase
    .from('owners')
    .select('restaurant_id')
    .single<{ restaurant_id: string }>();
  if (!owner) fail('/settings', 'Not logged in.');

  const slotInterval = Number(formData.get('slotInterval'));
  const defaultMaxCovers = Number(formData.get('defaultMaxCovers'));
  if (!Number.isInteger(slotInterval) || slotInterval < 15 || slotInterval > 120)
    fail('/settings', 'Slot interval must be between 15 and 120 minutes.');
  if (!Number.isInteger(defaultMaxCovers) || defaultMaxCovers < 0)
    fail('/settings', 'Default max covers must be 0 or more.');

  const hours: OperatingHours = {};
  const TIME_RE = /^\d{2}:\d{2}$/;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let d = 0; d < 7; d++) {
    const open = String(formData.get(`open_${d}`) ?? '18:00');
    const close = String(formData.get(`close_${d}`) ?? '22:00');
    const closed = formData.get(`closed_${d}`) === 'on';
    if (!closed && (!TIME_RE.test(open) || !TIME_RE.test(close) || open >= close))
      fail('/settings', `${DAY_NAMES[d]}: opening time must be before closing time.`);
    hours[String(d)] = { open, close, closed };
  }

  const language = String(formData.get('language') ?? 'en');
  if (!['en', 'pt', 'de', 'fr'].includes(language)) fail('/settings', 'Invalid language.');

  const { error } = await supabase
    .from('restaurants')
    .update({
      slot_interval_minutes: slotInterval,
      default_max_covers: defaultMaxCovers,
      operating_hours: hours,
      language,
    })
    .eq('id', owner.restaurant_id);
  if (error) fail('/settings', `Could not save settings: ${error.message}`);

  // Per-day cap overrides: blank input = no override (delete the rule).
  for (let d = 0; d < 7; d++) {
    const raw = String(formData.get(`cap_${d}`) ?? '').trim();
    const del = () =>
      supabase
        .from('capacity_rules')
        .delete()
        .eq('restaurant_id', owner.restaurant_id)
        .eq('day_of_week', d)
        .is('specific_date', null)
        .is('time_slot', null);
    if (raw === '') {
      await del();
    } else {
      const cap = Number(raw);
      if (!Number.isInteger(cap) || cap < 0)
        fail('/settings', `Invalid cap override for ${DAY_NAMES[d]}.`);
      await del();
      const { error: capErr } = await supabase.from('capacity_rules').insert({
        restaurant_id: owner.restaurant_id,
        day_of_week: d,
        max_covers: cap,
      });
      if (capErr) fail('/settings', `Could not save cap override: ${capErr.message}`);
    }
  }

  revalidatePath('/settings');
  redirect('/settings?saved=1');
}
