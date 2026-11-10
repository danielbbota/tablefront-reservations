'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { toMinutes } from '@/lib/availability';
import { isRealDate, UUID_RE } from '@/lib/appointments/data';
import {
  sendAppointmentCancellation,
  sendAppointmentConfirmation,
} from '@/lib/appointments/email';
import { appointmentTimes, staffIsFree } from '@/lib/appointments/slots';
import { asLang, getT } from '@/lib/i18n';
import { parseMoney } from '@/lib/money';
import { expireSession } from '@/lib/payments/checkout';
import {
  currencyOf,
  type Appointment,
  type AppointmentServiceStatus,
  type OperatingHours,
  type PaymentAccount,
  type Restaurant,
  type Service,
  type Staff,
} from '@/lib/types';

/**
 * Dashboard actions for the appointments product. Reads and plain writes go
 * through the owner's cookie client, so RLS scopes them to the owner's own
 * business. Creating an appointment goes through create_appointment() with
 * the service-role client (the function is service-role only), after the
 * professional and service were read under RLS, which proves they are the
 * owner's.
 *
 * Form-bound actions return void; feedback flows via redirect query params.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(path: string, message: string): never {
  redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`);
}

async function context() {
  const supabase = await createServerSupabase();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  if (!business) redirect('/login');
  return { supabase, business, t: getT(asLang(business.language)) };
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim();

/** Only ever send the owner back to a page of this product. */
function safeBack(back: string | undefined, fallback: string): string {
  return back && /^\/(agenda|services|team)(\/|\?|$)/.test(back) ? back : fallback;
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export async function createManualAppointment(formData: FormData) {
  const { supabase, business, t } = await context();
  const back = '/agenda/new';

  const serviceId = text(formData, 'serviceId');
  const staffId = text(formData, 'staffId');
  const date = text(formData, 'date');
  const time = text(formData, 'time');
  const name = text(formData, 'name');

  if (!UUID_RE.test(serviceId)) fail(back, t('appt.err.service'));
  if (!UUID_RE.test(staffId)) fail(back, t('appt.err.staff'));
  if (!isRealDate(date)) fail(back, t('appt.err.date'));
  if (!TIME_RE.test(time)) fail(back, t('appt.err.time'));
  if (!name) fail(back, t('appt.err.name'));

  const [{ data: service }, { data: staff }] = await Promise.all([
    supabase.from('services').select('*').eq('id', serviceId).maybeSingle<Service>(),
    supabase.from('staff').select('*').eq('id', staffId).maybeSingle<Staff>(),
  ]);
  if (!service) fail(back, t('appt.err.service'));
  if (!staff) fail(back, t('appt.err.staff'));

  const times = appointmentTimes(time, service);
  if (!times) fail(back, t('appt.err.pastMidnight'));

  // Manual appointments may sit outside opening hours and are never charged;
  // the only thing that stops them is a clash with another appointment.
  const { data: created, error } = await createAdminClient()
    .rpc('create_appointment', {
      p_restaurant_id: business.id,
      p_service_id: service.id,
      p_staff_id: staff.id,
      p_date: date,
      p_start_time: times.start,
      p_end_time: times.end,
      p_busy_until: times.busyUntil,
      p_service_name: service.name,
      p_duration_minutes: service.duration_minutes,
      p_price_cents: service.price_cents,
      p_guest_name: name,
      p_guest_phone: text(formData, 'phone'),
      p_guest_email: text(formData, 'email'),
      p_notes: text(formData, 'notes') || null,
      p_source: 'manual',
      p_guest_lang: asLang(business.language),
      p_amount_due_cents: 0,
      p_currency: currencyOf(business),
      p_hold_minutes: 0,
    })
    .single<Appointment>();

  if (error || !created) {
    if (error?.message.includes('SLOT_TAKEN')) fail(back, t('appt.err.taken', { staff: staff.name }));
    fail(back, t('appt.err.create', { message: error?.message ?? '' }));
  }

  if (created.guest_email) await sendAppointmentConfirmation(business, created, staff.name);

  revalidatePath('/agenda');
  redirect(`/agenda?date=${date}`);
}

export async function updateAppointment(appointmentId: string, formData: FormData) {
  const { supabase, t } = await context();
  const back = `/agenda/${appointmentId}`;

  const { data: appt } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .maybeSingle<Appointment>();
  if (!appt) fail('/agenda/list', t('appt.err.notFound'));

  const serviceId = text(formData, 'serviceId');
  const staffId = text(formData, 'staffId');
  const date = text(formData, 'date');
  const time = text(formData, 'time');
  const name = text(formData, 'name');

  if (!UUID_RE.test(staffId)) fail(back, t('appt.err.staff'));
  if (!isRealDate(date)) fail(back, t('appt.err.date'));
  if (!TIME_RE.test(time)) fail(back, t('appt.err.time'));
  if (!name) fail(back, t('appt.err.name'));

  // Same service (or a deleted one): keep the snapshot taken at booking time.
  let timing = {
    duration_minutes: appt.duration_minutes,
    buffer_minutes: Math.max(0, toMinutes(appt.busy_until) - toMinutes(appt.end_time)),
  };
  let snapshot: Pick<Appointment, 'service_id' | 'service_name' | 'duration_minutes' | 'price_cents'> | null =
    null;
  if (UUID_RE.test(serviceId) && serviceId !== appt.service_id) {
    const { data: service } = await supabase
      .from('services')
      .select('*')
      .eq('id', serviceId)
      .maybeSingle<Service>();
    if (!service) fail(back, t('appt.err.service'));
    timing = { duration_minutes: service.duration_minutes, buffer_minutes: service.buffer_minutes };
    snapshot = {
      service_id: service.id,
      service_name: service.name,
      duration_minutes: service.duration_minutes,
      price_cents: service.price_cents,
    };
  }

  const { data: staff } = await supabase
    .from('staff')
    .select('*')
    .eq('id', staffId)
    .maybeSingle<Staff>();
  if (!staff) fail(back, t('appt.err.staff'));

  const times = appointmentTimes(time, timing);
  if (!times) fail(back, t('appt.err.pastMidnight'));

  if (appt.status !== 'cancelled') {
    const { data: sameDay } = await supabase
      .from('appointments')
      .select('*')
      .eq('staff_id', staffId)
      .eq('date', date)
      .neq('status', 'cancelled')
      .returns<Appointment[]>();
    const free = staffIsFree(
      staffId,
      date,
      toMinutes(times.start),
      timing,
      sameDay ?? [],
      [],
      new Date(),
      appt.id
    );
    if (!free) fail(back, t('appt.err.taken', { staff: staff.name }));
  }

  const { error } = await supabase
    .from('appointments')
    .update({
      ...(snapshot ?? {}),
      staff_id: staffId,
      date,
      start_time: times.start,
      end_time: times.end,
      busy_until: times.busyUntil,
      guest_name: name,
      guest_phone: text(formData, 'phone'),
      guest_email: text(formData, 'email'),
      notes: text(formData, 'notes') || null,
    })
    .eq('id', appointmentId);
  if (error) fail(back, t('appt.err.update', { message: error.message }));

  revalidatePath('/agenda');
  redirect(`/agenda?date=${date}`);
}

/** Cancel (emails the guest) or re-confirm (only if the time is still free). */
export async function setAppointmentStatus(
  appointmentId: string,
  status: 'confirmed' | 'cancelled',
  back?: string
) {
  const { supabase, business, t } = await context();
  const target = safeBack(back, '/agenda/list');

  const { data: appt } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .maybeSingle<Appointment>();
  if (!appt) fail(target, t('appt.err.notFound'));

  const { data: staff } = await supabase
    .from('staff')
    .select('*')
    .eq('id', appt.staff_id)
    .maybeSingle<Staff>();

  if (status === 'cancelled') {
    const { data: cancelled, error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        hold_expires_at: null,
        ...(appt.payment_status === 'pending' ? { payment_status: 'none' } : {}),
      })
      .eq('id', appointmentId)
      .neq('status', 'cancelled')
      .select()
      .maybeSingle<Appointment>();
    if (error) fail(target, t('appt.err.update', { message: error.message }));
    // A hold the owner gives up must not be payable any more.
    if (cancelled && appt.status === 'pending_payment' && appt.stripe_session_id) {
      const { data: account } = await supabase
        .from('payment_accounts')
        .select('*')
        .maybeSingle<PaymentAccount>();
      if (account) await expireSession(account.stripe_account_id, appt.stripe_session_id);
    }
    // A hold that was never paid was never confirmed to the guest: no email.
    if (cancelled && appt.status === 'confirmed' && cancelled.guest_email) {
      await sendAppointmentCancellation(business, cancelled, staff?.name ?? null);
    }
  } else {
    const { data: sameDay } = await supabase
      .from('appointments')
      .select('*')
      .eq('staff_id', appt.staff_id)
      .eq('date', appt.date)
      .neq('status', 'cancelled')
      .returns<Appointment[]>();
    const free = staffIsFree(
      appt.staff_id,
      appt.date,
      toMinutes(appt.start_time),
      {
        duration_minutes: appt.duration_minutes,
        buffer_minutes: Math.max(0, toMinutes(appt.busy_until) - toMinutes(appt.end_time)),
      },
      sameDay ?? [],
      [],
      new Date(),
      appt.id
    );
    if (!free) fail(target, t('appt.err.taken', { staff: staff?.name ?? '' }));

    const { error } = await supabase
      .from('appointments')
      .update({
        status: 'confirmed',
        hold_expires_at: null,
        ...(appt.payment_status === 'pending' ? { payment_status: 'none' } : {}),
      })
      .eq('id', appointmentId);
    if (error) fail(target, t('appt.err.update', { message: error.message }));
  }

  revalidatePath('/agenda');
  redirect(target);
}

/** Tap-to-toggle day-of-service status on the calendar (arrived / completed / no-show). */
export async function setAppointmentServiceStatus(
  appointmentId: string,
  status: AppointmentServiceStatus,
  date: string
) {
  const { supabase, t } = await context();
  const back = `/agenda?date=${isRealDate(date) ? date : ''}`;

  const { data: appt } = await supabase
    .from('appointments')
    .select('service_status')
    .eq('id', appointmentId)
    .maybeSingle<Pick<Appointment, 'service_status'>>();
  if (!appt) fail(back, t('appt.err.notFound'));

  const { error } = await supabase
    .from('appointments')
    .update({ service_status: appt.service_status === status ? null : status })
    .eq('id', appointmentId);
  if (error) fail(back, t('appt.err.update', { message: error.message }));

  revalidatePath('/agenda');
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export async function saveService(formData: FormData) {
  const { supabase, business, t } = await context();
  const id = text(formData, 'id');
  const editing = UUID_RE.test(id);
  const back = editing ? `/services?edit=${id}` : '/services';

  const name = text(formData, 'name');
  const duration = Number(formData.get('duration'));
  const buffer = Number(formData.get('buffer') || 0);
  const price = parseMoney(formData.get('price') || '0');

  if (!name || name.length > 120) fail(back, t('svc.err.name'));
  if (!Number.isInteger(duration) || duration < 5 || duration > 480)
    fail(back, t('svc.err.duration'));
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) fail(back, t('svc.err.buffer'));
  if (price === null) fail(back, t('svc.err.price'));

  const row = {
    name,
    category: text(formData, 'category') || null,
    description: text(formData, 'description') || null,
    duration_minutes: duration,
    buffer_minutes: buffer,
    price_cents: price,
    active: formData.get('active') === 'on',
  };

  const { error } = editing
    ? await supabase.from('services').update(row).eq('id', id)
    : await supabase.from('services').insert({ ...row, restaurant_id: business.id });
  if (error) fail(back, t('svc.err.save', { message: error.message }));

  revalidatePath('/services');
  redirect('/services?saved=1');
}

/** Past appointments keep their own copy of the name, duration and price. */
export async function deleteService(serviceId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('services').delete().eq('id', serviceId);
  if (error) fail('/services', t('svc.err.save', { message: error.message }));
  revalidatePath('/services');
  redirect('/services?deleted=1');
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export async function saveStaff(formData: FormData) {
  const { supabase, business, t } = await context();
  const id = text(formData, 'id');
  const editing = UUID_RE.test(id);
  const back = editing ? `/team/${id}` : '/team';

  const name = text(formData, 'name');
  const color = text(formData, 'color') || '#c9954a';
  if (!name || name.length > 120) fail(back, t('team.err.name'));
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(back, t('team.err.color'));

  // Own hours only when the owner switched them on; otherwise null = the
  // business's opening hours.
  let workingHours: OperatingHours | null = null;
  if (formData.get('ownHours') === 'on') {
    workingHours = {};
    for (let d = 0; d < 7; d++) {
      const open = String(formData.get(`open_${d}`) ?? '09:00');
      const close = String(formData.get(`close_${d}`) ?? '18:00');
      const closed = formData.get(`closed_${d}`) === 'on';
      if (!closed && (!TIME_RE.test(open) || !TIME_RE.test(close) || open >= close)) {
        fail(back, t('team.err.hours', { day: t(`days.${d}` as 'days.0') }));
      }
      workingHours[String(d)] = { open, close, closed };
    }
  }

  const row = {
    name,
    title: text(formData, 'title') || null,
    color,
    working_hours: workingHours,
    // The add form has no switch: new professionals start active.
    active: editing ? formData.get('active') === 'on' : true,
  };

  let staffId = id;
  if (editing) {
    const { error } = await supabase.from('staff').update(row).eq('id', id);
    if (error) fail(back, t('team.err.save', { message: error.message }));
  } else {
    const { data: created, error } = await supabase
      .from('staff')
      .insert({ ...row, restaurant_id: business.id })
      .select('id')
      .single<{ id: string }>();
    if (error || !created) fail(back, t('team.err.save', { message: error?.message ?? '' }));
    staffId = created.id;
  }

  // Replace the service list with the ticked ones (only the owner's own services).
  const { data: services } = await supabase.from('services').select('id').returns<{ id: string }[]>();
  const own = new Set((services ?? []).map((s) => s.id));
  const chosen = Array.from(new Set(formData.getAll('services').map(String))).filter((s) =>
    own.has(s)
  );
  await supabase.from('staff_services').delete().eq('staff_id', staffId);
  if (chosen.length) {
    const { error } = await supabase.from('staff_services').insert(
      chosen.map((serviceId) => ({
        staff_id: staffId,
        service_id: serviceId,
        restaurant_id: business.id,
      }))
    );
    if (error) fail(`/team/${staffId}`, t('team.err.save', { message: error.message }));
  }

  revalidatePath('/team');
  redirect(editing ? `/team/${staffId}?saved=1` : '/team?saved=1');
}

/**
 * Delete a professional. One who has appointments cannot be deleted (the
 * foreign key refuses, by design: history stays intact), so they are
 * deactivated instead and disappear from online booking.
 */
export async function deleteStaff(staffId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('staff').delete().eq('id', staffId);
  if (error) {
    if (error.code !== '23503') fail(`/team/${staffId}`, t('team.err.save', { message: error.message }));
    const { error: offErr } = await supabase.from('staff').update({ active: false }).eq('id', staffId);
    if (offErr) fail(`/team/${staffId}`, t('team.err.save', { message: offErr.message }));
    revalidatePath('/team');
    redirect('/team?deactivated=1');
  }
  revalidatePath('/team');
  redirect('/team?deleted=1');
}

export async function addTimeOff(staffId: string, formData: FormData) {
  const { supabase, business, t } = await context();
  const back = `/team/${staffId}`;

  const date = text(formData, 'date');
  const allDay = formData.get('allDay') === 'on';
  const start = text(formData, 'start');
  const end = text(formData, 'end');

  if (!isRealDate(date)) fail(back, t('appt.err.date'));
  if (!allDay && (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end)) {
    fail(back, t('team.err.timeOff'));
  }

  const { error } = await supabase.from('staff_time_off').insert({
    restaurant_id: business.id,
    staff_id: staffId,
    date,
    start_time: allDay ? null : start,
    end_time: allDay ? null : end,
    reason: text(formData, 'reason') || null,
  });
  if (error) fail(back, t('team.err.save', { message: error.message }));

  revalidatePath('/agenda');
  redirect(`${back}?saved=1`);
}

export async function deleteTimeOff(timeOffId: string, staffId: string) {
  const { supabase, t } = await context();
  const { error } = await supabase.from('staff_time_off').delete().eq('id', timeOffId);
  if (error) fail(`/team/${staffId}`, t('team.err.save', { message: error.message }));
  revalidatePath('/agenda');
  redirect(`/team/${staffId}?saved=1`);
}
