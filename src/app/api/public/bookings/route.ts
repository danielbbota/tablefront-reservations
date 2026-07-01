import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  nowInTimezone,
  resolveMaxCovers,
  slotsForDate,
  toMinutes,
} from '@/lib/availability';
import { corsJson, corsPreflight } from '@/lib/cors';
import { sendGuestConfirmation, sendOwnerNotification } from '@/lib/email';
import {
  BOOKING_HORIZON_DAYS,
  MAX_PARTY_SIZE,
  type Booking,
  type CapacityRule,
  type Restaurant,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/public/bookings
 * Body: { restaurant, date, time, partySize, name, phone, email, notes? }
 * Creates a confirmed widget booking, atomically enforcing the online cover cap.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: 'Invalid JSON body' }, 400);
  }

  const restaurantId = String(body.restaurant ?? '');
  const date = String(body.date ?? '');
  const time = String(body.time ?? '');
  const partySize = Number(body.partySize);
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const email = String(body.email ?? '').trim();
  const notes = String(body.notes ?? '').trim().slice(0, 1000) || null;

  if (!restaurantId) return corsJson({ error: 'Missing restaurant' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return corsJson({ error: 'Invalid date' }, 400);
  if (!/^\d{2}:\d{2}$/.test(time)) return corsJson({ error: 'Invalid time' }, 400);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > MAX_PARTY_SIZE)
    return corsJson({ error: 'Invalid party size' }, 400);
  if (!name || name.length > 120) return corsJson({ error: 'Name is required' }, 400);
  if (!phone || phone.length > 40) return corsJson({ error: 'Phone is required' }, 400);
  if (!EMAIL_RE.test(email)) return corsJson({ error: 'A valid email is required' }, 400);

  const supabase = createAdminClient();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single<Restaurant>();
  if (!restaurant) return corsJson({ error: 'Restaurant not found' }, 404);

  // The requested time must be a real slot for that date, not in the past,
  // and within the booking horizon (all in the restaurant's timezone).
  const now = nowInTimezone(restaurant.timezone);
  const horizon = new Date(now.date + 'T00:00:00Z');
  horizon.setUTCDate(horizon.getUTCDate() + BOOKING_HORIZON_DAYS);
  if (date < now.date || date > horizon.toISOString().slice(0, 10))
    return corsJson({ error: 'Date is not bookable' }, 400);
  if (date === now.date && toMinutes(time) <= now.minutes)
    return corsJson({ error: 'That time has already passed' }, 400);
  if (!slotsForDate(restaurant, date).includes(time))
    return corsJson({ error: 'That time is not available for booking' }, 400);

  const { data: rules } = await supabase
    .from('capacity_rules')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .returns<CapacityRule[]>();
  const maxCovers = resolveMaxCovers(restaurant, rules ?? [], date, time);

  const { data: booking, error } = await supabase
    .rpc('create_widget_booking', {
      p_restaurant_id: restaurantId,
      p_date: date,
      p_time_slot: time,
      p_party_size: partySize,
      p_guest_name: name,
      p_guest_phone: phone,
      p_guest_email: email,
      p_notes: notes,
      p_max_covers: maxCovers,
    })
    .single<Booking>();

  if (error) {
    if (error.message.includes('SLOT_FULL')) {
      return corsJson(
        { error: 'Sorry, that time just filled up. Please pick another slot.', code: 'SLOT_FULL' },
        409
      );
    }
    console.error('[bookings] create failed:', error);
    return corsJson({ error: 'Could not create the booking. Please try again.' }, 500);
  }

  // Notifications swallow their own errors — they can delay the response
  // slightly but never fail the booking. Awaited because serverless kills
  // un-awaited promises once the response is returned.
  const { data: owner } = await supabase
    .from('owners')
    .select('email')
    .eq('restaurant_id', restaurantId)
    .limit(1)
    .maybeSingle<{ email: string }>();

  await Promise.allSettled([
    sendGuestConfirmation(restaurant, booking),
    owner?.email
      ? sendOwnerNotification(restaurant, booking, owner.email)
      : Promise.resolve(),
  ]);

  return corsJson(
    {
      booking: {
        id: booking.id,
        date: booking.date,
        time: time,
        partySize: booking.party_size,
        status: booking.status,
      },
    },
    201
  );
}
