import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { sendAppointmentReminder } from '@/lib/appointments/email';
import { sendGuestReminder } from '@/lib/email';
import { sendStayReminder } from '@/lib/stays/email';
import { runChannelHousekeeping } from '@/lib/stays/housekeeping';
import {
  businessTypeOf,
  type Appointment,
  type Booking,
  type Restaurant,
  type Staff,
  type StayReservation,
  type StayUnit,
} from '@/lib/types';

export const maxDuration = 60;

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/cron/reminders — invoked daily by Vercel Cron (vercel.json).
 * Sends each guest a reminder (in their own language, with the cancel link)
 * for tomorrow's confirmed bookings, once per booking: restaurant tables,
 * stays arriving tomorrow and appointments tomorrow.
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

    const type = businessTypeOf(restaurant);
    if (type === 'stays') {
      const r = await remindStays(supabase, restaurant, tomorrow);
      sent += r.sent;
      failures.push(...r.failures);
      continue;
    }
    if (type === 'appointments') {
      const r = await remindAppointments(supabase, restaurant, tomorrow);
      sent += r.sent;
      failures.push(...r.failures);
      continue;
    }

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

  // Same daily run: safety-net pull of the stays channel calendars and tidy-up
  // of expired payment holds. Never allowed to fail the reminders.
  let channels: Awaited<ReturnType<typeof runChannelHousekeeping>> | { error: string };
  try {
    channels = await runChannelHousekeeping(supabase);
  } catch (err) {
    console.error('[cron/reminders] channel housekeeping failed', err);
    channels = { error: 'failed' };
  }

  return NextResponse.json({ sent, failures, channels });
}

type Admin = ReturnType<typeof createAdminClient>;
type Outcome = { sent: number; failures: string[] };

/** Direct reservations (the ones with a guest email) arriving tomorrow. */
async function remindStays(supabase: Admin, business: Restaurant, tomorrow: string): Promise<Outcome> {
  const out: Outcome = { sent: 0, failures: [] };
  const [{ data: reservations }, { data: units }] = await Promise.all([
    supabase
      .from('stay_reservations')
      .select('*')
      .eq('restaurant_id', business.id)
      .eq('check_in', tomorrow)
      .eq('status', 'confirmed')
      .neq('guest_email', '')
      .is('reminder_sent_at', null)
      .returns<StayReservation[]>(),
    supabase
      .from('stay_units')
      .select('id, name')
      .eq('restaurant_id', business.id)
      .returns<Pick<StayUnit, 'id' | 'name'>[]>(),
  ]);
  const unitById = new Map((units ?? []).map((u) => [u.id, u]));

  for (const res of reservations ?? []) {
    // Mark first so a retried cron run can't double-email a guest.
    const { data: claimed } = await supabase
      .from('stay_reservations')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', res.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) continue;
    try {
      await sendStayReminder(business, unitById.get(res.unit_id), res);
      out.sent++;
    } catch (err) {
      out.failures.push(res.id);
      console.error('[cron/reminders] failed for stay reservation', res.id, err);
    }
  }
  return out;
}

async function remindAppointments(supabase: Admin, business: Restaurant, tomorrow: string): Promise<Outcome> {
  const out: Outcome = { sent: 0, failures: [] };
  const [{ data: appointments }, { data: staff }] = await Promise.all([
    supabase
      .from('appointments')
      .select('*')
      .eq('restaurant_id', business.id)
      .eq('date', tomorrow)
      .eq('status', 'confirmed')
      .neq('guest_email', '')
      .is('reminder_sent_at', null)
      .returns<Appointment[]>(),
    supabase
      .from('staff')
      .select('id, name')
      .eq('restaurant_id', business.id)
      .returns<Pick<Staff, 'id' | 'name'>[]>(),
  ]);
  const staffName = new Map((staff ?? []).map((s) => [s.id, s.name]));

  for (const appt of appointments ?? []) {
    const { data: claimed } = await supabase
      .from('appointments')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', appt.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) continue;
    try {
      await sendAppointmentReminder(business, appt, staffName.get(appt.staff_id));
      out.sent++;
    } catch (err) {
      out.failures.push(appt.id);
      console.error('[cron/reminders] failed for appointment', appt.id, err);
    }
  }
  return out;
}
