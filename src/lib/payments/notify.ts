import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sendAppointmentConfirmation,
  sendAppointmentOwnerNotification,
} from '../appointments/email';
import { sendStayConfirmation, sendStayOwnerNotification } from '../stays/email';
import type { Appointment, Restaurant, Staff, StayReservation, StayUnit } from '../types';
import type { PayableKind } from './checkout';

/**
 * The emails a booking gets once it is confirmed: guest confirmation and
 * owner notice. For paid bookings this runs after payment (webhook or the
 * /pay return page), never when the hold is created. Never throws.
 */
export async function notifyConfirmed(
  supabase: SupabaseClient,
  kind: PayableKind,
  row: StayReservation | Appointment
) {
  try {
    const [{ data: business }, { data: owner }] = await Promise.all([
      supabase.from('restaurants').select('*').eq('id', row.restaurant_id).maybeSingle<Restaurant>(),
      supabase
        .from('owners')
        .select('email')
        .eq('restaurant_id', row.restaurant_id)
        .limit(1)
        .maybeSingle<{ email: string }>(),
    ]);
    if (!business) return;

    if (kind === 'stay') {
      const res = row as StayReservation;
      const { data: unit } = await supabase
        .from('stay_units')
        .select('name')
        .eq('id', res.unit_id)
        .maybeSingle<Pick<StayUnit, 'name'>>();
      await Promise.allSettled([
        sendStayConfirmation(business, unit, res),
        owner?.email ? sendStayOwnerNotification(business, unit, res, owner.email) : Promise.resolve(),
      ]);
      return;
    }

    const appt = row as Appointment;
    const { data: staff } = await supabase
      .from('staff')
      .select('name')
      .eq('id', appt.staff_id)
      .maybeSingle<Pick<Staff, 'name'>>();
    await Promise.allSettled([
      sendAppointmentConfirmation(business, appt, staff?.name),
      owner?.email
        ? sendAppointmentOwnerNotification(business, appt, owner.email, staff?.name)
        : Promise.resolve(),
    ]);
  } catch (err) {
    console.error('[payments] confirmation emails failed for', kind, row.id, err);
  }
}
