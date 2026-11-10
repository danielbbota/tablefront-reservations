'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { asLang, getT } from '@/lib/i18n';
import { parseMoney } from '@/lib/money';
import { unitIsFree } from '@/lib/stays/availability';
import { isIsoDate } from '@/lib/stays/dates';
import { sendStayCancellation, sendStayConfirmation } from '@/lib/stays/email';
import { quoteStay } from '@/lib/stays/pricing';
import { FeedUrlError, assertSafeFeedUrl, syncFeed, syncFeeds } from '@/lib/stays/sync';
import {
  STAY_CHANNELS,
  currencyOf,
  type Restaurant,
  type StayBlock,
  type StayChannel,
  type StayIcalFeed,
  type StayRate,
  type StayReservation,
  type StayStatus,
  type StayUnit,
} from '@/lib/types';

/**
 * Dashboard actions for the stays product. Reads and plain writes go through
 * the owner's cookie client, so RLS keeps them inside the owner's business.
 * The service-role client is used only where the database insists on it
 * (the atomic create_stay_reservation function, channel sync), always with
 * ids that were first read under RLS.
 *
 * Form-bound actions return void; feedback flows via redirect query params.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^\d{2}:\d{2}$/;

function fail(path: string, message: string): never {
  const sep = path.includes('?') ? '&' : '?';
  redirect(`${path}${sep}error=${encodeURIComponent(message)}`);
}

async function context() {
  const supabase = await createServerSupabase();
  const { data: business } = await supabase.from('restaurants').select('*').single<Restaurant>();
  if (!business) redirect('/login');
  return { supabase, business, t: getT(asLang(business.language)) };
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export async function createStayReservation(formData: FormData) {
  const { supabase, business, t } = await context();
  const back = '/stays/new';

  const unitId = text(formData, 'unitId');
  const checkIn = text(formData, 'checkIn');
  const checkOut = text(formData, 'checkOut');
  const guests = Number(formData.get('guests'));
  const name = text(formData, 'name');
  const email = text(formData, 'email');
  const totalRaw = text(formData, 'total');

  if (!UUID_RE.test(unitId)) fail(back, t('stay.err.unit'));
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn)
    fail(back, t('stay.err.dates'));
  if (!Number.isInteger(guests) || guests < 1 || guests > 30) fail(back, t('stay.err.guests'));
  if (!name) fail(back, t('stay.err.name'));

  // Read under RLS: proves the unit is the owner's before the service role acts.
  const [{ data: unit }, { data: rates }] = await Promise.all([
    supabase.from('stay_units').select('*').eq('id', unitId).maybeSingle<StayUnit>(),
    supabase.from('stay_rates').select('*').eq('unit_id', unitId).returns<StayRate[]>(),
  ]);
  if (!unit) fail(back, t('stay.err.unit'));

  let total = quoteStay(unit, rates ?? [], checkIn, checkOut).total_cents;
  if (totalRaw !== '') {
    const parsed = parseMoney(totalRaw);
    if (parsed === null) fail(back, t('stay.err.total'));
    total = parsed;
  }

  // Unlike restaurant covers, a unit cannot be sold twice: manual
  // reservations go through the same atomic check as the widget.
  const { data: created, error } = await createAdminClient()
    .rpc('create_stay_reservation', {
      p_restaurant_id: business.id,
      p_unit_id: unitId,
      p_check_in: checkIn,
      p_check_out: checkOut,
      p_guests: guests,
      p_guest_name: name,
      p_guest_phone: text(formData, 'phone'),
      p_guest_email: email,
      p_notes: text(formData, 'notes') || null,
      p_source: 'manual',
      p_guest_lang: business.language ?? 'en',
      p_total_cents: total,
      p_amount_due_cents: 0,
      p_currency: currencyOf(business),
      p_hold_minutes: 0,
    })
    .single<StayReservation>();

  if (error || !created) {
    if (error?.message.includes('DATES_TAKEN')) fail(back, t('stay.err.taken'));
    fail(back, t('stay.err.generic', { message: error?.message ?? '' }));
  }

  if (created.guest_email) await sendStayConfirmation(business, unit, created);

  revalidatePath('/stays');
  redirect('/stays/reservations');
}

export async function updateStayReservation(reservationId: string, formData: FormData) {
  const { supabase, t } = await context();
  const back = `/stays/reservations/${reservationId}`;

  const { data: current } = await supabase
    .from('stay_reservations')
    .select('*')
    .eq('id', reservationId)
    .maybeSingle<StayReservation>();
  if (!current) fail('/stays/reservations', t('stay.err.notFound'));

  const guests = Number(formData.get('guests'));
  const name = text(formData, 'name');
  if (!name) fail(back, t('stay.err.name'));
  if (!Number.isInteger(guests) || guests < 1 || guests > 30) fail(back, t('stay.err.guests'));

  const update: Record<string, unknown> = {
    guest_name: name,
    guest_phone: text(formData, 'phone'),
    guest_email: text(formData, 'email'),
    notes: text(formData, 'notes') || null,
    guests,
  };

  const totalRaw = text(formData, 'total');
  if (totalRaw !== '') {
    const parsed = parseMoney(totalRaw);
    if (parsed === null) fail(back, t('stay.err.total'));
    update.total_cents = parsed;
  }

  // Dates and unit of a channel reservation belong to the channel: the next
  // sync would overwrite them anyway. Guest details and notes are ours to keep.
  if (!current.feed_id) {
    const unitId = text(formData, 'unitId');
    const checkIn = text(formData, 'checkIn');
    const checkOut = text(formData, 'checkOut');
    if (!UUID_RE.test(unitId)) fail(back, t('stay.err.unit'));
    if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn)
      fail(back, t('stay.err.dates'));

    const moved =
      unitId !== current.unit_id || checkIn !== current.check_in || checkOut !== current.check_out;
    if (moved && current.status !== 'cancelled') {
      const free = await datesAreFree(supabase, unitId, checkIn, checkOut, reservationId);
      if (free === null) fail(back, t('stay.err.unit'));
      if (!free) fail(back, t('stay.err.taken'));
    }
    update.unit_id = unitId;
    update.check_in = checkIn;
    update.check_out = checkOut;
  }

  const { error } = await supabase.from('stay_reservations').update(update).eq('id', reservationId);
  if (error) fail(back, t('stay.err.generic', { message: error.message }));

  revalidatePath('/stays');
  redirect('/stays/reservations');
}

/** null = the unit is not the owner's; otherwise whether the nights are free. */
async function datesAreFree(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  unitId: string,
  checkIn: string,
  checkOut: string,
  ignoreReservationId?: string
): Promise<boolean | null> {
  const [{ data: unit }, { data: reservations }, { data: blocks }] = await Promise.all([
    supabase.from('stay_units').select('id').eq('id', unitId).maybeSingle<{ id: string }>(),
    supabase
      .from('stay_reservations')
      .select('id, unit_id, check_in, check_out, status, hold_expires_at')
      .eq('unit_id', unitId)
      .neq('status', 'cancelled')
      .lt('check_in', checkOut)
      .gt('check_out', checkIn)
      .returns<
        Pick<StayReservation, 'id' | 'unit_id' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'>[]
      >(),
    supabase
      .from('stay_blocks')
      .select('unit_id, start_date, end_date')
      .eq('unit_id', unitId)
      .lt('start_date', checkOut)
      .gt('end_date', checkIn)
      .returns<Pick<StayBlock, 'unit_id' | 'start_date' | 'end_date'>[]>(),
  ]);
  if (!unit) return null;
  return unitIsFree(unitId, checkIn, checkOut, reservations ?? [], blocks ?? [], new Date(), ignoreReservationId);
}

export async function setStayReservationStatus(
  reservationId: string,
  status: 'confirmed' | 'cancelled'
) {
  const { supabase, business, t } = await context();
  const back = '/stays/reservations';

  const { data: current } = await supabase
    .from('stay_reservations')
    .select('*')
    .eq('id', reservationId)
    .maybeSingle<StayReservation>();
  if (!current) fail(back, t('stay.err.notFound'));
  if (current.feed_id) fail(back, t('stay.err.channelManaged'));

  if (status === 'confirmed') {
    const free = await datesAreFree(supabase, current.unit_id, current.check_in, current.check_out, current.id);
    if (!free) fail(back, t('stay.err.taken'));
  }

  const { data: updated, error } = await supabase
    .from('stay_reservations')
    .update({
      status,
      hold_expires_at: null,
      ...(current.status === 'pending_payment' ? { payment_status: 'none' } : {}),
    })
    .eq('id', reservationId)
    .select()
    .single<StayReservation>();
  if (error || !updated) fail(back, t('stay.err.generic', { message: error?.message ?? '' }));

  // A hold that was never paid was never confirmed to the guest: no email.
  if (status === 'cancelled' && current.status === 'confirmed') {
    const { data: unit } = await supabase
      .from('stay_units')
      .select('name')
      .eq('id', updated.unit_id)
      .maybeSingle<Pick<StayUnit, 'name'>>();
    await sendStayCancellation(business, unit, updated);
  }

  revalidatePath('/stays');
  revalidatePath('/stays/reservations');
}

/** Tap-to-toggle arrival status (checked in / checked out / no-show). */
export async function setStayStatus(reservationId: string, stayStatus: StayStatus) {
  const { supabase, t } = await context();
  const { data: current } = await supabase
    .from('stay_reservations')
    .select('stay_status')
    .eq('id', reservationId)
    .maybeSingle<Pick<StayReservation, 'stay_status'>>();
  if (!current) fail('/stays', t('stay.err.notFound'));

  const next = current.stay_status === stayStatus ? null : stayStatus;
  const { error } = await supabase
    .from('stay_reservations')
    .update({ stay_status: next })
    .eq('id', reservationId);
  if (error) fail('/stays', t('stay.err.generic', { message: error.message }));

  revalidatePath('/stays');
}

// ---------------------------------------------------------------------------
// Date blocks
// ---------------------------------------------------------------------------

export async function createStayBlock(formData: FormData) {
  const { supabase, business, t } = await context();
  const back = '/stays/new';

  const unitId = text(formData, 'unitId');
  const start = text(formData, 'start');
  const end = text(formData, 'end');
  if (!UUID_RE.test(unitId)) fail(back, t('stay.err.unit'));
  if (!isIsoDate(start) || !isIsoDate(end) || end <= start) fail(back, t('stay.err.dates'));

  const { error } = await supabase.from('stay_blocks').insert({
    restaurant_id: business.id,
    unit_id: unitId,
    start_date: start,
    end_date: end,
    reason: text(formData, 'reason') || null,
  });
  if (error) fail(back, t('stay.err.generic', { message: error.message }));

  revalidatePath('/stays');
  redirect('/stays/new?blocked=1');
}

export async function deleteStayBlock(blockId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('stay_blocks').delete().eq('id', blockId);
  if (error) fail('/stays/new', t('stay.err.generic', { message: error.message }));
  revalidatePath('/stays');
  revalidatePath('/stays/new');
}

// ---------------------------------------------------------------------------
// Units and rates
// ---------------------------------------------------------------------------

export async function saveStayUnit(formData: FormData) {
  const { supabase, business, t } = await context();
  const id = text(formData, 'id');
  const editing = UUID_RE.test(id);
  const back = editing ? `/stays/units/${id}` : '/stays/units';

  const name = text(formData, 'name');
  const maxGuests = Number(formData.get('maxGuests'));
  const minNights = Number(formData.get('minNights') ?? 1);
  const price = parseMoney(formData.get('price'));
  const cleaning = parseMoney(text(formData, 'cleaningFee') || '0');

  if (!name || name.length > 120) fail(back, t('stay.err.unitName'));
  if (!Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > 30) fail(back, t('stay.err.guests'));
  if (!Number.isInteger(minNights) || minNights < 1 || minNights > 90) fail(back, t('stay.err.minNights'));
  if (price === null || cleaning === null) fail(back, t('stay.err.price'));

  const row = {
    name,
    description: text(formData, 'description') || null,
    max_guests: maxGuests,
    min_nights: minNights,
    base_price_cents: price,
    cleaning_fee_cents: cleaning,
  };

  if (editing) {
    const { error } = await supabase
      .from('stay_units')
      .update({ ...row, active: formData.get('active') === 'on' })
      .eq('id', id);
    if (error) fail(back, t('stay.err.generic', { message: error.message }));
    revalidatePath('/stays/units');
    redirect(`/stays/units/${id}?saved=1`);
  }

  const { count } = await supabase.from('stay_units').select('id', { count: 'exact', head: true });
  const { data: created, error } = await supabase
    .from('stay_units')
    .insert({ ...row, restaurant_id: business.id, sort: count ?? 0 })
    .select('id')
    .single<{ id: string }>();
  if (error || !created) fail(back, t('stay.err.generic', { message: error?.message ?? '' }));

  revalidatePath('/stays/units');
  redirect(`/stays/units/${created.id}?saved=1`);
}

export async function deleteStayUnit(unitId: string) {
  const { supabase, t } = await context();
  const back = `/stays/units/${unitId}`;

  // Deleting a unit would cascade to its reservations. Refuse while it has
  // any history: the owner deactivates it instead.
  const { count } = await supabase
    .from('stay_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('unit_id', unitId);
  if ((count ?? 0) > 0) fail(back, t('stay.err.unitHasReservations'));

  const { error } = await supabase.from('stay_units').delete().eq('id', unitId);
  if (error) fail(back, t('stay.err.generic', { message: error.message }));

  revalidatePath('/stays/units');
  redirect('/stays/units');
}

export async function addStayRate(unitId: string, formData: FormData) {
  const { supabase, business, t } = await context();
  const back = `/stays/units/${unitId}`;

  const start = text(formData, 'start');
  const end = text(formData, 'end');
  const price = parseMoney(formData.get('price'));
  const minRaw = text(formData, 'minNights');
  const minNights = minRaw === '' ? null : Number(minRaw);

  if (!isIsoDate(start) || !isIsoDate(end) || end < start) fail(back, t('stay.err.rateDates'));
  if (price === null) fail(back, t('stay.err.price'));
  if (minNights !== null && (!Number.isInteger(minNights) || minNights < 1 || minNights > 90))
    fail(back, t('stay.err.minNights'));

  const { error } = await supabase.from('stay_rates').insert({
    restaurant_id: business.id,
    unit_id: unitId,
    start_date: start,
    end_date: end,
    price_cents: price,
    min_nights: minNights,
  });
  if (error) fail(back, t('stay.err.generic', { message: error.message }));

  revalidatePath(back);
  redirect(`${back}?saved=1#rates`);
}

export async function deleteStayRate(rateId: string, unitId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('stay_rates').delete().eq('id', rateId);
  if (error) fail(`/stays/units/${unitId}`, t('stay.err.generic', { message: error.message }));
  revalidatePath(`/stays/units/${unitId}`);
}

// ---------------------------------------------------------------------------
// Channel calendars (Airbnb / Booking.com / Vrbo)
// ---------------------------------------------------------------------------

export async function addStayFeed(unitId: string, formData: FormData) {
  const { supabase, business, t } = await context();
  const back = `/stays/units/${unitId}`;

  const channel = text(formData, 'channel') as StayChannel;
  const url = text(formData, 'url');
  if (!STAY_CHANNELS.includes(channel)) fail(back, t('stay.err.feedUrl'));
  try {
    assertSafeFeedUrl(url);
  } catch (err) {
    if (err instanceof FeedUrlError) fail(back, t('stay.err.feedUrl'));
    throw err;
  }

  const { data: feed, error } = await supabase
    .from('stay_ical_feeds')
    .insert({ restaurant_id: business.id, unit_id: unitId, channel, url })
    .select()
    .single<StayIcalFeed>();
  if (error || !feed) {
    if (error?.code === '23505') fail(back, t('stay.err.feedDuplicate'));
    fail(back, t('stay.err.generic', { message: error?.message ?? '' }));
  }

  // Import right away so the owner sees the channel's reservations at once.
  const result = await syncFeed(createAdminClient(), feed);

  revalidatePath('/stays');
  revalidatePath(back);
  if (!result.ok) fail(`${back}#channels`, t('stay.sync.feedFailed', { message: result.error ?? '' }));
  redirect(`${back}?synced=${result.imported}#channels`);
}

export async function deleteStayFeed(feedId: string, unitId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('stay_ical_feeds').delete().eq('id', feedId);
  if (error) fail(`/stays/units/${unitId}`, t('stay.err.generic', { message: error.message }));
  revalidatePath('/stays');
  revalidatePath(`/stays/units/${unitId}`);
}

/** "Sync now": pull every channel calendar of the business. */
export async function syncStayChannels(formData: FormData) {
  const { business } = await context();
  const back = text(formData, 'back').startsWith('/stays') ? text(formData, 'back') : '/stays';

  const results = await syncFeeds(createAdminClient(), { restaurantId: business.id });
  const failed = results.filter((r) => !r.ok).length;
  const changes = results.reduce((n, r) => n + r.imported + r.updated + r.cancelled, 0);

  revalidatePath('/stays');
  const sep = back.includes('?') ? '&' : '?';
  redirect(`${back}${sep}synced=${changes}&feeds=${results.length}&failed=${failed}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveStaysSettings(formData: FormData) {
  const { supabase, business, t } = await context();
  const back = '/settings';

  const language = text(formData, 'language');
  if (!['en', 'pt', 'de', 'fr'].includes(language)) fail(back, 'Invalid language.');

  const timezone = text(formData, 'timezone');
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      fail(back, `Invalid timezone: ${timezone}`);
    }
  }

  const currency = text(formData, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(back, t('stay.err.currency'));

  const checkInTime = text(formData, 'checkInTime');
  const checkOutTime = text(formData, 'checkOutTime');
  if (!TIME_RE.test(checkInTime) || !TIME_RE.test(checkOutTime)) fail(back, t('stay.err.times'));

  const { error } = await supabase
    .from('restaurants')
    .update({
      language,
      currency,
      check_in_time: checkInTime,
      check_out_time: checkOutTime,
      ...(timezone ? { timezone } : {}),
    })
    .eq('id', business.id);
  if (error) fail(back, t('stay.err.generic', { message: error.message }));

  revalidatePath('/settings');
  redirect('/settings?saved=1');
}
