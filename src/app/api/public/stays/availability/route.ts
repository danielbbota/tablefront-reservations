import { after, NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, corsPreflight } from '@/lib/cors';
import { getPaymentSetup, paymentTerms } from '@/lib/payments/checkout';
import { availableUnits, unitIsFree } from '@/lib/stays/availability';
import { minNightsFor } from '@/lib/stays/pricing';
import { checkStayDates } from '@/lib/stays/request';
import { anyFeedStale, syncFeeds } from '@/lib/stays/sync';
import {
  businessTypeOf,
  currencyOf,
  type Restaurant,
  type StayBlock,
  type StayIcalFeed,
  type StayRate,
  type StayReservation,
  type StayUnit,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/** Channel calendars older than this are refreshed in the background. */
const BACKGROUND_SYNC_MINUTES = 15;

/**
 * GET /api/public/stays/availability?restaurant=<id>&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N
 * Units free for those nights and that party, each with its price for the stay.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const businessId = q.get('restaurant');
  const checkIn = q.get('checkIn');
  const checkOut = q.get('checkOut');
  const guests = Number(q.get('guests') ?? '1');

  if (!businessId) return corsJson({ error: 'restaurant is required' }, 400);
  if (!Number.isInteger(guests) || guests < 1 || guests > 30) {
    return corsJson({ error: 'Invalid number of guests' }, 400);
  }

  const supabase = createAdminClient();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', businessId)
    .single<Restaurant>();
  if (!business || businessTypeOf(business) !== 'stays') {
    return corsJson({ error: 'Business not found' }, 404);
  }

  const dates = checkStayDates(business, checkIn, checkOut);
  if (!dates.ok) return corsJson({ error: dates.message, code: dates.code }, 400);
  const stay = { checkIn: checkIn as string, checkOut: checkOut as string, guests };

  const [{ data: units }, { data: rates }, { data: reservations }, { data: blocks }, { data: feeds }] =
    await Promise.all([
      supabase
        .from('stay_units')
        .select('*')
        .eq('restaurant_id', businessId)
        .eq('active', true)
        .order('sort')
        .returns<StayUnit[]>(),
      supabase
        .from('stay_rates')
        .select('*')
        .eq('restaurant_id', businessId)
        .gte('end_date', stay.checkIn)
        .returns<StayRate[]>(),
      supabase
        .from('stay_reservations')
        .select('id, unit_id, check_in, check_out, status, hold_expires_at')
        .eq('restaurant_id', businessId)
        .neq('status', 'cancelled')
        .lt('check_in', stay.checkOut)
        .gt('check_out', stay.checkIn)
        .returns<
          Pick<StayReservation, 'id' | 'unit_id' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'>[]
        >(),
      supabase
        .from('stay_blocks')
        .select('unit_id, start_date, end_date')
        .eq('restaurant_id', businessId)
        .lt('start_date', stay.checkOut)
        .gt('end_date', stay.checkIn)
        .returns<Pick<StayBlock, 'unit_id' | 'start_date' | 'end_date'>[]>(),
      supabase
        .from('stay_ical_feeds')
        .select('last_synced_at')
        .eq('restaurant_id', businessId)
        .returns<Pick<StayIcalFeed, 'last_synced_at'>[]>(),
    ]);

  // Keep channel calendars fresh without making the guest wait. The booking
  // endpoint syncs the chosen unit again, synchronously, before confirming.
  if (anyFeedStale(feeds ?? [], BACKGROUND_SYNC_MINUTES)) {
    after(async () => {
      await syncFeeds(supabase, { restaurantId: businessId }, BACKGROUND_SYNC_MINUTES);
    });
  }

  const offers = availableUnits(units ?? [], rates ?? [], reservations ?? [], blocks ?? [], stay);
  const setup = offers.length ? await getPaymentSetup(supabase, business) : null;

  // When nothing fits only because the stay is too short, say how long it has to be.
  let minNights: number | undefined;
  if (!offers.length) {
    const required = (units ?? [])
      .filter((u) => u.max_guests >= guests)
      .filter((u) => unitIsFree(u.id, stay.checkIn, stay.checkOut, reservations ?? [], blocks ?? []))
      .map((u) => minNightsFor(u, rates ?? [], stay.checkIn))
      .filter((n) => n > dates.nights);
    if (required.length) minNights = Math.min(...required);
  }

  return corsJson({
    business: { id: business.id, name: business.name },
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    nights: dates.nights,
    guests,
    currency: currencyOf(business),
    minNights,
    units: offers.map(({ unit, quote }) => ({
      id: unit.id,
      name: unit.name,
      description: unit.description,
      maxGuests: unit.max_guests,
      nights: quote.nights,
      accommodationCents: quote.accommodation_cents,
      cleaningFeeCents: quote.cleaning_fee_cents,
      totalCents: quote.total_cents,
      dueNowCents: paymentTerms(quote.total_cents, setup).amountDueCents,
    })),
  });
}
