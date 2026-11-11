import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runChannelHousekeeping } from '@/lib/stays/housekeeping';

export const maxDuration = 60;

/**
 * GET /api/cron/stays-sync — pull every channel calendar (Airbnb /
 * Booking.com / Vrbo) and tidy expired payment holds.
 *
 * Not scheduled on its own: the daily /api/cron/reminders job runs the same
 * housekeeping, so the project keeps a single cron entry. Day-to-day
 * freshness does not depend on either: calendars are also re-read when an
 * owner opens the stays calendar and right before a direct booking is
 * confirmed. To sync more often (Vercel Pro), add this path to vercel.json
 * with an every-15-minutes schedule.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await runChannelHousekeeping(createAdminClient()));
}
