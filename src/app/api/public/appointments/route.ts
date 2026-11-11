import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { corsJson, corsPreflight } from '@/lib/cors';
import { horizonDate, isRealDate, loadDayContext, UUID_RE } from '@/lib/appointments/data';
import {
  sendAppointmentConfirmation,
  sendAppointmentOwnerNotification,
} from '@/lib/appointments/email';
import {
  appointmentTimes,
  availableSlots,
  eligibleStaff,
  rankStaff,
} from '@/lib/appointments/slots';
import { getPaymentSetup, paymentTerms, startCheckout } from '@/lib/payments/checkout';
import { asLang } from '@/lib/i18n';
import {
  APPOINTMENT_HORIZON_DAYS,
  businessTypeOf,
  currencyOf,
  type Appointment,
  type Restaurant,
  type Service,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const slotTaken = () =>
  corsJson(
    { error: 'Sorry, that time is no longer available. Please pick another one.', code: 'SLOT_TAKEN' },
    409
  );

/**
 * POST /api/public/appointments
 * Body: { restaurant, service, staff ("any" or an id), date, time, name, phone, email, notes?, lang? }
 * Books the appointment atomically (one professional can never be double
 * booked). When the business charges online the appointment is held and the
 * response carries `checkoutUrl`; it is confirmed once the payment arrives.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') return corsJson({ error: 'Invalid JSON body' }, 400);

  const businessId = String(body.restaurant ?? '');
  const serviceId = String(body.service ?? '');
  const staffId = String(body.staff ?? 'any') || 'any';
  const date = String(body.date ?? '');
  const time = String(body.time ?? '');
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const email = String(body.email ?? '').trim();
  const notes = String(body.notes ?? '').trim().slice(0, 1000) || null;
  const lang = ['en', 'pt', 'de', 'fr'].includes(String(body.lang)) ? String(body.lang) : null;

  if (!businessId) return corsJson({ error: 'Missing restaurant' }, 400);
  if (!UUID_RE.test(serviceId)) return corsJson({ error: 'Invalid service' }, 400);
  if (staffId !== 'any' && !UUID_RE.test(staffId))
    return corsJson({ error: 'Invalid professional' }, 400);
  if (!isRealDate(date)) return corsJson({ error: 'Invalid date' }, 400);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return corsJson({ error: 'Invalid time' }, 400);
  if (!name || name.length > 120) return corsJson({ error: 'Name is required' }, 400);
  if (!phone || phone.length > 40) return corsJson({ error: 'Phone is required' }, 400);
  if (!EMAIL_RE.test(email) || email.length > 200)
    return corsJson({ error: 'A valid email is required' }, 400);

  const supabase = createAdminClient();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', businessId)
    .single<Restaurant>();
  if (!business || businessTypeOf(business) !== 'appointments') {
    return corsJson({ error: 'Business not found' }, 404);
  }

  // Bookable window, in the business's own timezone.
  const clock = nowInTimezone(business.timezone);
  if (date < clock.date || date > horizonDate(clock.date, APPOINTMENT_HORIZON_DAYS)) {
    return corsJson({ error: 'Date is not bookable' }, 400);
  }

  const { data: service } = await supabase
    .from('services')
    .select('*')
    .eq('id', serviceId)
    .eq('restaurant_id', business.id)
    .eq('active', true)
    .maybeSingle<Service>();
  if (!service) return corsJson({ error: 'Service not found' }, 404);

  const ctx = await loadDayContext(supabase, business.id, date);
  if (staffId !== 'any' && !eligibleStaff(service.id, ctx.staff, ctx.staffServices, staffId).length) {
    return corsJson({ error: 'That professional does not offer this service' }, 400);
  }

  // The requested time must be one the guest could actually have been shown.
  const slot = availableSlots({ business, service, ...ctx, date, staffId, clock }).find(
    (s) => s.time === time
  );
  const times = appointmentTimes(time, service);
  if (!slot || !times) return slotTaken();

  const setup = await getPaymentSetup(supabase, business);
  const terms = paymentTerms(service.price_cents, setup);
  const currency = currencyOf(business);
  const guestLang = asLang(lang ?? business.language);

  // "Any professional": try the least busy first; the database function is
  // the referee if another guest takes one of them in the meantime.
  let appointment: Appointment | null = null;
  for (const candidate of rankStaff(slot.staffIds, ctx.staff, ctx.appointments, date)) {
    const { data, error } = await supabase
      .rpc('create_appointment', {
        p_restaurant_id: business.id,
        p_service_id: service.id,
        p_staff_id: candidate,
        p_date: date,
        p_start_time: times.start,
        p_end_time: times.end,
        p_busy_until: times.busyUntil,
        p_service_name: service.name,
        p_duration_minutes: service.duration_minutes,
        p_price_cents: service.price_cents,
        p_guest_name: name,
        p_guest_phone: phone,
        p_guest_email: email,
        p_notes: notes,
        p_source: 'widget',
        p_guest_lang: guestLang,
        p_amount_due_cents: terms.amountDueCents,
        p_currency: currency,
        p_hold_minutes: terms.holdMinutes,
      })
      .single<Appointment>();
    if (data) {
      appointment = data;
      break;
    }
    if (error && !error.message.includes('SLOT_TAKEN')) {
      console.error('[appointments] create failed:', error);
      return corsJson({ error: 'Could not create the appointment. Please try again.' }, 500);
    }
  }
  if (!appointment) return slotTaken();

  const staffName = ctx.staff.find((s) => s.id === appointment.staff_id)?.name ?? null;
  const summary = {
    id: appointment.id,
    date: appointment.date,
    time: times.start,
    endTime: times.end,
    serviceName: appointment.service_name,
    staffName,
    priceCents: appointment.price_cents,
    status: appointment.status,
  };

  if (setup && terms.holdMinutes > 0) {
    try {
      const checkoutUrl = await startCheckout(
        supabase,
        setup,
        {
          kind: 'appointment',
          id: appointment.id,
          cancelToken: appointment.cancel_token,
          amountCents: terms.amountDueCents,
          currency,
          title: `${service.name} — ${business.name}`,
          description: `${date} ${times.start}${staffName ? ` · ${staffName}` : ''}`,
          email,
          lang: guestLang,
        },
        process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin
      );
      // No emails yet: they go out when the payment is confirmed.
      return corsJson({ appointment: summary, checkoutUrl }, 201);
    } catch (err) {
      console.error('[appointments] checkout failed:', err);
      return corsJson({ error: 'Could not start the payment. Please try again.' }, 502);
    }
  }

  // Notifications swallow their own errors; awaited because serverless kills
  // un-awaited promises once the response is returned.
  const { data: owner } = await supabase
    .from('owners')
    .select('email')
    .eq('restaurant_id', business.id)
    .limit(1)
    .maybeSingle<{ email: string }>();

  await Promise.allSettled([
    sendAppointmentConfirmation(business, appointment, staffName),
    owner?.email
      ? sendAppointmentOwnerNotification(business, appointment, owner.email, staffName)
      : Promise.resolve(),
  ]);

  return corsJson({ appointment: summary }, 201);
}
