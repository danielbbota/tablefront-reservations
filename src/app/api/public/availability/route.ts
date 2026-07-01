import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { availabilityForDate, normalizeSlot, nowInTimezone } from '@/lib/availability';
import { corsJson, corsPreflight } from '@/lib/cors';
import { BOOKING_HORIZON_DAYS, MAX_PARTY_SIZE, type Booking, type CapacityRule, type Restaurant } from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/public/availability?restaurant=<id>&date=YYYY-MM-DD
 * Returns restaurant display info and per-slot remaining online covers.
 */
export async function GET(req: NextRequest) {
  const restaurantId = req.nextUrl.searchParams.get('restaurant');
  const date = req.nextUrl.searchParams.get('date');

  if (!restaurantId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return corsJson({ error: 'restaurant and date (YYYY-MM-DD) are required' }, 400);
  }

  const supabase = createAdminClient();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single<Restaurant>();

  if (!restaurant) {
    return corsJson({ error: 'Restaurant not found' }, 404);
  }

  const today = nowInTimezone(restaurant.timezone).date;
  const horizon = new Date(today + 'T00:00:00Z');
  horizon.setUTCDate(horizon.getUTCDate() + BOOKING_HORIZON_DAYS);
  if (date > horizon.toISOString().slice(0, 10)) {
    return corsJson({ error: 'Date is beyond the booking window' }, 400);
  }

  const [{ data: rules }, { data: bookings }] = await Promise.all([
    supabase
      .from('capacity_rules')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .returns<CapacityRule[]>(),
    supabase
      .from('bookings')
      .select('time_slot, party_size')
      .eq('restaurant_id', restaurantId)
      .eq('date', date)
      .eq('status', 'confirmed')
      .returns<Pick<Booking, 'time_slot' | 'party_size'>[]>(),
  ]);

  const bookedBySlot = new Map<string, number>();
  for (const b of bookings ?? []) {
    const key = normalizeSlot(b.time_slot);
    bookedBySlot.set(key, (bookedBySlot.get(key) ?? 0) + b.party_size);
  }

  const slots = availabilityForDate(restaurant, rules ?? [], date, bookedBySlot);

  return corsJson({
    restaurant: { id: restaurant.id, name: restaurant.name },
    date,
    maxPartySize: MAX_PARTY_SIZE,
    horizonDays: BOOKING_HORIZON_DAYS,
    slots,
  });
}
