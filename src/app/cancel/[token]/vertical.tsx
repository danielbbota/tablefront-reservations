import { redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone, normalizeSlot } from '@/lib/availability';
import {
  sendAppointmentCancellation,
  sendAppointmentOwnerCancelNotice,
} from '@/lib/appointments/email';
import { asLang, getT } from '@/lib/i18n';
import { expireSession } from '@/lib/payments/checkout';
import { isChannelSource } from '@/lib/stays/display';
import { sendStayCancellation, sendStayOwnerCancelNotice } from '@/lib/stays/email';
import type {
  Appointment,
  PaymentAccount,
  Restaurant,
  Staff,
  StayReservation,
  StayUnit,
} from '@/lib/types';

/**
 * Guest self-cancellation for stays and appointments, reached through the
 * same /cancel/<token> link as restaurant bookings. The unguessable
 * cancel_token is the credential; everything renders in the guest's language.
 */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="tf-rise w-full max-w-md rounded-2xl border border-linen bg-white p-8 shadow-lift">
        {children}
      </div>
    </main>
  );
}

const ownerEmail = async (supabase: SupabaseClient, businessId: string) =>
  (
    await supabase
      .from('owners')
      .select('email')
      .eq('restaurant_id', businessId)
      .limit(1)
      .maybeSingle<{ email: string }>()
  ).data?.email;

/** A hold the guest walks away from: also close its Stripe session. */
async function closeOpenSession(
  supabase: SupabaseClient,
  row: Pick<StayReservation, 'restaurant_id' | 'stripe_session_id'>
) {
  if (!row.stripe_session_id) return;
  const { data: account } = await supabase
    .from('payment_accounts')
    .select('stripe_account_id')
    .eq('restaurant_id', row.restaurant_id)
    .maybeSingle<Pick<PaymentAccount, 'stripe_account_id'>>();
  if (account) await expireSession(account.stripe_account_id, row.stripe_session_id);
}

// ---------------------------------------------------------------------------
// Stays
// ---------------------------------------------------------------------------

export async function StayCancel({
  token,
  reservation,
  done,
}: {
  token: string;
  reservation: StayReservation;
  done: boolean;
}) {
  const supabase = createAdminClient();
  const [{ data: business }, { data: unit }] = await Promise.all([
    supabase.from('restaurants').select('*').eq('id', reservation.restaurant_id).single<Restaurant>(),
    supabase
      .from('stay_units')
      .select('name')
      .eq('id', reservation.unit_id)
      .maybeSingle<Pick<StayUnit, 'name'>>(),
  ]);
  const t = getT(asLang(reservation.guest_lang));
  if (!business) {
    return (
      <Card>
        <p className="text-sm text-espresso">{t('cancel.notFound')}</p>
      </Card>
    );
  }

  const title = <h1 className="font-serif text-xl font-semibold text-espresso">{t('stay.cancel.title')}</h1>;
  const summary = (
    <div className="mt-4 space-y-1 rounded-lg bg-sand/60 p-4 text-sm text-espresso">
      <p className="font-serif text-base font-semibold">{business.name}</p>
      {unit?.name && <p>{unit.name}</p>}
      <p>
        {reservation.check_in} → {reservation.check_out} · {reservation.guests}
      </p>
      <p className="text-espresso/60">{reservation.guest_name}</p>
    </div>
  );
  const note = (text: string, tone: 'ok' | 'plain' = 'plain') => (
    <Card>
      {title}
      <p
        className={
          tone === 'ok'
            ? 'mt-3 rounded-lg bg-leaf/10 px-4 py-3 text-sm text-leaf'
            : 'mt-3 text-sm text-espresso/70'
        }
      >
        {text}
      </p>
      {summary}
    </Card>
  );

  if (done || reservation.status === 'cancelled') {
    return note(done ? t('stay.cancel.done') : t('stay.cancel.already'), 'ok');
  }
  if (isChannelSource(reservation.source)) return note(t('stay.cancel.channel'));
  if (reservation.check_in <= nowInTimezone(business.timezone).date) return note(t('stay.cancel.past'));

  async function cancelReservation() {
    'use server';
    const supabase = createAdminClient();
    const { data: before } = await supabase
      .from('stay_reservations')
      .select('*')
      .eq('cancel_token', token)
      .maybeSingle<StayReservation>();
    // Re-read under the token and only flip a live direct reservation.
    const { data: fresh } = await supabase
      .from('stay_reservations')
      .update({ status: 'cancelled', hold_expires_at: null })
      .eq('cancel_token', token)
      .in('status', ['confirmed', 'pending_payment'])
      .is('feed_id', null)
      .select()
      .maybeSingle<StayReservation>();

    if (fresh && before) {
      if (before.status === 'pending_payment') {
        await closeOpenSession(supabase, fresh);
      } else {
        const [{ data: rest }, { data: u }, owner] = await Promise.all([
          supabase.from('restaurants').select('*').eq('id', fresh.restaurant_id).single<Restaurant>(),
          supabase.from('stay_units').select('name').eq('id', fresh.unit_id).maybeSingle<Pick<StayUnit, 'name'>>(),
          ownerEmail(supabase, fresh.restaurant_id),
        ]);
        if (rest) {
          await Promise.allSettled([
            sendStayCancellation(rest, u, fresh),
            owner ? sendStayOwnerCancelNotice(rest, u, fresh, owner) : Promise.resolve(),
          ]);
        }
      }
    }
    redirect(`/cancel/${token}?done=1`);
  }

  return (
    <Card>
      {title}
      <p className="mt-2 text-sm text-espresso/70">{t('stay.cancel.intro', { business: business.name })}</p>
      {summary}
      {reservation.paid_cents > 0 && (
        <p className="mt-3 text-xs text-espresso/60">{t('cancel.refundNote', { business: business.name })}</p>
      )}
      <form action={cancelReservation} className="mt-5">
        <button className="min-h-11 w-full rounded-lg bg-wine px-4 py-2.5 text-sm font-semibold text-cream transition hover:opacity-90 active:scale-[0.985]">
          {t('stay.cancel.confirm')}
        </button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export async function AppointmentCancel({
  token,
  appointment,
  done,
}: {
  token: string;
  appointment: Appointment;
  done: boolean;
}) {
  const supabase = createAdminClient();
  const [{ data: business }, { data: staff }] = await Promise.all([
    supabase.from('restaurants').select('*').eq('id', appointment.restaurant_id).single<Restaurant>(),
    supabase.from('staff').select('name').eq('id', appointment.staff_id).maybeSingle<Pick<Staff, 'name'>>(),
  ]);
  const t = getT(asLang(appointment.guest_lang));
  if (!business) {
    return (
      <Card>
        <p className="text-sm text-espresso">{t('cancel.notFound')}</p>
      </Card>
    );
  }

  const title = <h1 className="font-serif text-xl font-semibold text-espresso">{t('cancel.appt.title')}</h1>;
  const summary = (
    <div className="mt-4 space-y-1 rounded-lg bg-sand/60 p-4 text-sm text-espresso">
      <p className="font-serif text-base font-semibold">{business.name}</p>
      <p>
        {appointment.service_name}
        {staff?.name ? ` · ${staff.name}` : ''}
      </p>
      <p>
        {appointment.date} · {normalizeSlot(appointment.start_time)}
      </p>
      <p className="text-espresso/60">{appointment.guest_name}</p>
    </div>
  );
  const note = (text: string, tone: 'ok' | 'plain' = 'plain') => (
    <Card>
      {title}
      <p
        className={
          tone === 'ok'
            ? 'mt-3 rounded-lg bg-leaf/10 px-4 py-3 text-sm text-leaf'
            : 'mt-3 text-sm text-espresso/70'
        }
      >
        {text}
      </p>
      {summary}
    </Card>
  );

  if (done || appointment.status === 'cancelled') {
    return note(done ? t('cancel.appt.done') : t('cancel.appt.already'), 'ok');
  }
  if (appointment.date < nowInTimezone(business.timezone).date) return note(t('cancel.appt.past'));

  async function cancelAppointment() {
    'use server';
    const supabase = createAdminClient();
    const { data: before } = await supabase
      .from('appointments')
      .select('*')
      .eq('cancel_token', token)
      .maybeSingle<Appointment>();
    const { data: fresh } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', hold_expires_at: null })
      .eq('cancel_token', token)
      .in('status', ['confirmed', 'pending_payment'])
      .select()
      .maybeSingle<Appointment>();

    if (fresh && before) {
      if (before.status === 'pending_payment') {
        await closeOpenSession(supabase, fresh);
      } else {
        const [{ data: rest }, { data: who }, owner] = await Promise.all([
          supabase.from('restaurants').select('*').eq('id', fresh.restaurant_id).single<Restaurant>(),
          supabase.from('staff').select('name').eq('id', fresh.staff_id).maybeSingle<Pick<Staff, 'name'>>(),
          ownerEmail(supabase, fresh.restaurant_id),
        ]);
        if (rest) {
          await Promise.allSettled([
            sendAppointmentCancellation(rest, fresh, who?.name),
            owner ? sendAppointmentOwnerCancelNotice(rest, fresh, owner, who?.name) : Promise.resolve(),
          ]);
        }
      }
    }
    redirect(`/cancel/${token}?done=1`);
  }

  return (
    <Card>
      {title}
      <p className="mt-2 text-sm text-espresso/70">{t('cancel.appt.intro', { business: business.name })}</p>
      {summary}
      {appointment.paid_cents > 0 && (
        <p className="mt-3 text-xs text-espresso/60">{t('cancel.refundNote', { business: business.name })}</p>
      )}
      <form action={cancelAppointment} className="mt-5">
        <button className="min-h-11 w-full rounded-lg bg-wine px-4 py-2.5 text-sm font-semibold text-cream transition hover:opacity-90 active:scale-[0.985]">
          {t('cancel.appt.confirm')}
        </button>
      </form>
    </Card>
  );
}
