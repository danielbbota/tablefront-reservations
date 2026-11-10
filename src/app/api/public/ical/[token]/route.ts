import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { isLive } from '@/lib/stays/availability';
import { addDays } from '@/lib/stays/dates';
import { generateIcal, type ExportEvent } from '@/lib/stays/ical';
import {
  STAY_CHANNELS,
  type Restaurant,
  type StayBlock,
  type StayChannel,
  type StayReservation,
  type StayUnit,
} from '@/lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/public/ical/<unit ical_token>.ics[?for=airbnb|booking|vrbo|other]
 *
 * The unit's busy dates as an iCalendar feed, to paste into Airbnb /
 * Booking.com / Vrbo ("import calendar"). The token is the credential.
 *
 * `for=<channel>` leaves out reservations that came from that same channel:
 * the channel already knows about its own bookings, and feeding them back
 * would keep the dates blocked there after a guest cancels on the channel.
 * No guest data is included.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.ics$/i, '');
  if (!UUID_RE.test(token)) return new NextResponse('Not found', { status: 404 });

  const forChannel = req.nextUrl.searchParams.get('for') as StayChannel | null;
  const exclude = forChannel && STAY_CHANNELS.includes(forChannel) ? forChannel : null;

  const supabase = createAdminClient();
  const { data: unit } = await supabase
    .from('stay_units')
    .select('*')
    .eq('ical_token', token)
    .maybeSingle<StayUnit>();
  if (!unit) return new NextResponse('Not found', { status: 404 });

  const { data: business } = await supabase
    .from('restaurants')
    .select('name, timezone')
    .eq('id', unit.restaurant_id)
    .maybeSingle<Pick<Restaurant, 'name' | 'timezone'>>();
  // Past stays are irrelevant to a channel; keep a little history for safety.
  const since = addDays(nowInTimezone(business?.timezone ?? 'UTC').date, -30);

  const [{ data: reservations }, { data: blocks }] = await Promise.all([
    supabase
      .from('stay_reservations')
      .select('id, check_in, check_out, status, hold_expires_at, source')
      .eq('unit_id', unit.id)
      .neq('status', 'cancelled')
      .gte('check_out', since)
      .order('check_in')
      .returns<
        Pick<StayReservation, 'id' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at' | 'source'>[]
      >(),
    supabase
      .from('stay_blocks')
      .select('id, start_date, end_date')
      .eq('unit_id', unit.id)
      .gte('end_date', since)
      .order('start_date')
      .returns<Pick<StayBlock, 'id' | 'start_date' | 'end_date'>[]>(),
  ]);

  const events: ExportEvent[] = [
    ...(reservations ?? [])
      .filter((r) => isLive(r) && r.source !== exclude)
      .map((r) => ({ uid: `res-${r.id}`, start: r.check_in, end: r.check_out, summary: 'Reserved' })),
    ...(blocks ?? []).map((b) => ({
      uid: `block-${b.id}`,
      start: b.start_date,
      end: b.end_date,
      summary: 'Not available',
    })),
  ];

  return new NextResponse(generateIcal(`${business?.name ?? 'TableFront'} — ${unit.name}`, events), {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
