import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, corsPreflight } from '@/lib/cors';
import { getPaymentSetup, paymentTerms, startCheckout } from '@/lib/payments/checkout';
import { sendStayConfirmation, sendStayOwnerNotification } from '@/lib/stays/email';
import { quoteStay } from '@/lib/stays/pricing';
import { checkStayDates } from '@/lib/stays/request';
import { syncFeeds } from '@/lib/stays/sync';
import {
  businessTypeOf,
  currencyOf,
  type Lang,
  type Restaurant,
  type StayRate,
  type StayReservation,
  type StayUnit,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Before confirming, re-read channel calendars older than this for the chosen unit. */
const PRE_BOOKING_SYNC_MINUTES = 10;

/**
 * POST /api/public/stays/reservations
 * Body: { restaurant, unit, checkIn, checkOut, guests, name, phone, email, notes?, lang? }
 *
 * Creates a direct reservation, atomically refusing dates that are taken.
 * The price is always computed here, never taken from the client. When the
 * business charges online, the reservation is a short hold and the response
 * carries `checkoutUrl`; it is confirmed (and the emails go out) once paid.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: 'Invalid JSON body' }, 400);
  }

  const businessId = String(body.restaurant ?? '');
  const unitId = String(body.unit ?? '');
  const checkIn = body.checkIn;
  const checkOut = body.checkOut;
  const guests = Number(body.guests);
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const email = String(body.email ?? '').trim();
  const notes = String(body.notes ?? '').trim().slice(0, 1000) || null;
  const lang = ['en', 'pt', 'de', 'fr'].includes(String(body.lang)) ? (String(body.lang) as Lang) : null;

  if (!businessId) return corsJson({ error: 'Missing restaurant' }, 400);
  if (!UUID_RE.test(unitId)) return corsJson({ error: 'Missing unit' }, 400);
  if (!Number.isInteger(guests) || guests < 1 || guests > 30)
    return corsJson({ error: 'Invalid number of guests' }, 400);
  if (!name || name.length > 120) return corsJson({ error: 'Name is required' }, 400);
  if (!phone || phone.length > 40) return corsJson({ error: 'Phone is required' }, 400);
  if (!EMAIL_RE.test(email)) return corsJson({ error: 'A valid email is required' }, 400);
  if (typeof checkIn !== 'string' || typeof checkOut !== 'string')
    return corsJson({ error: 'Check-in and check-out dates are required' }, 400);

  const supabase = createAdminClient();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', businessId)
    .single<Restaurant>();
  if (!business || businessTypeOf(business) !== 'stays')
    return corsJson({ error: 'Business not found' }, 404);

  const dates = checkStayDates(business, checkIn, checkOut);
  if (!dates.ok) return corsJson({ error: dates.message, code: dates.code }, 400);

  const [{ data: unit }, { data: rates }] = await Promise.all([
    supabase
      .from('stay_units')
      .select('*')
      .eq('id', unitId)
      .eq('restaurant_id', businessId)
      .eq('active', true)
      .maybeSingle<StayUnit>(),
    supabase
      .from('stay_rates')
      .select('*')
      .eq('unit_id', unitId)
      .eq('restaurant_id', businessId)
      .returns<StayRate[]>(),
  ]);
  if (!unit) return corsJson({ error: 'That unit is not available for booking' }, 404);
  if (guests > unit.max_guests)
    return corsJson({ error: `This unit sleeps up to ${unit.max_guests} guests` }, 400);

  const quote = quoteStay(unit, rates ?? [], checkIn, checkOut);
  if (quote.nights < quote.min_nights) {
    return corsJson(
      { error: `The minimum stay for these dates is ${quote.min_nights} nights`, code: 'MIN_NIGHTS' },
      400
    );
  }

  // Last look at Airbnb / Booking.com before we promise the dates. A channel
  // that is slow or down must not block direct bookings: failures are
  // recorded on the feed and the booking goes ahead on what we know.
  try {
    await syncFeeds(supabase, { unitId }, PRE_BOOKING_SYNC_MINUTES);
  } catch (err) {
    console.error('[stays] pre-booking sync failed:', err);
  }

  const setup = await getPaymentSetup(supabase, business);
  const terms = paymentTerms(quote.total_cents, setup);
  const currency = currencyOf(business);

  const { data: reservation, error } = await supabase
    .rpc('create_stay_reservation', {
      p_restaurant_id: businessId,
      p_unit_id: unitId,
      p_check_in: checkIn,
      p_check_out: checkOut,
      p_guests: guests,
      p_guest_name: name,
      p_guest_phone: phone,
      p_guest_email: email,
      p_notes: notes,
      p_source: 'widget',
      p_guest_lang: lang ?? business.language ?? 'en',
      p_total_cents: quote.total_cents,
      p_amount_due_cents: terms.amountDueCents,
      p_currency: currency,
      p_hold_minutes: terms.holdMinutes,
    })
    .single<StayReservation>();

  if (error || !reservation) {
    if (error?.message.includes('DATES_TAKEN')) {
      return corsJson(
        { error: 'Sorry, those dates were just taken. Please pick other dates.', code: 'DATES_TAKEN' },
        409
      );
    }
    console.error('[stays] create failed:', error);
    return corsJson({ error: 'Could not create the reservation. Please try again.' }, 500);
  }

  const summary = {
    id: reservation.id,
    unit: unit.name,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    nights: quote.nights,
    guests: reservation.guests,
    totalCents: reservation.total_cents,
    dueNowCents: terms.amountDueCents,
    currency,
    status: reservation.status,
  };

  if (setup && terms.holdMinutes > 0) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
      const checkoutUrl = await startCheckout(
        supabase,
        setup,
        {
          kind: 'stay',
          id: reservation.id,
          cancelToken: reservation.cancel_token,
          amountCents: terms.amountDueCents,
          currency,
          title: `${business.name} — ${unit.name}`,
          description: `${reservation.check_in} → ${reservation.check_out}`,
          email,
          lang: reservation.guest_lang,
        },
        appUrl
      );
      return corsJson({ reservation: summary, checkoutUrl }, 201);
    } catch (err) {
      console.error('[stays] checkout failed:', err);
      return corsJson(
        { error: 'Could not start the payment. Please try again.', code: 'PAYMENT_UNAVAILABLE' },
        502
      );
    }
  }

  const { data: owner } = await supabase
    .from('owners')
    .select('email')
    .eq('restaurant_id', businessId)
    .limit(1)
    .maybeSingle<{ email: string }>();

  await Promise.allSettled([
    sendStayConfirmation(business, unit, reservation),
    owner?.email
      ? sendStayOwnerNotification(business, unit, reservation, owner.email)
      : Promise.resolve(),
  ]);

  return corsJson({ reservation: summary }, 201);
}
