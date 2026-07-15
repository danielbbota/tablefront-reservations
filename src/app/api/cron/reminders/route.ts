import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { sendGuestReminder } from '@/lib/email';
import type { Booking, Restaurant } from '@/lib/types';

export const maxDuration = 60;

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/cron/reminders — invoked daily by Vercel Cron (vercel.json).
 * Sends each guest a reminder (in their own language, with the cancel link)
 * for tomorrow's confirmed bookings, once per booking.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('*')
    .returns<Restaurant[]>();

  let sent = 0;
  const failures: string[] = [];

  for (const restaurant of restaurants ?? []) {
    // "Tomorrow" in each restaurant's own timezone.
    const tomorrow = addDays(nowInTimezone(restaurant.timezone).date, 1);

    const { data: bookings } = await supabase
      .from('bookings')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .eq('date', tomorrow)
      .eq('status', 'confirmed')
      .is('reminder_sent_at', null)
      .returns<Booking[]>();

    for (const booking of bookings ?? []) {
      // Mark first so a retried cron run can't double-email a guest.
      const { data: claimed } = await supabase
        .from('bookings')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', booking.id)
        .is('reminder_sent_at', null)
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      try {
        await sendGuestReminder(restaurant, booking);
        sent++;
      } catch (err) {
        failures.push(booking.id);
        console.error('[cron/reminders] failed for booking', booking.id, err);
      }
    }
  }

  return NextResponse.json({ sent, failures });
}
