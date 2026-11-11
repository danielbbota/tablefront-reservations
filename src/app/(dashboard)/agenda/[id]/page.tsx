import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { setAppointmentStatus, updateAppointment } from '@/app/appointments-actions';
import { normalizeSlot } from '@/lib/availability';
import { UUID_RE } from '@/lib/appointments/data';
import { isLiveAppointment } from '@/lib/appointments/slots';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { currencyOf, type Appointment, type Service, type Staff } from '@/lib/types';
import AppointmentFields from '../appointment-fields';

export default async function EditAppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  if (!UUID_RE.test(id)) notFound();
  const lang = asLang(business.language);
  const t = getT(lang);

  const [{ data: appt }, { data: services }, { data: staff }] = await Promise.all([
    supabase.from('appointments').select('*').eq('id', id).maybeSingle<Appointment>(),
    supabase.from('services').select('*').order('sort').order('name').returns<Service[]>(),
    supabase.from('staff').select('*').order('sort').order('name').returns<Staff[]>(),
  ]);
  if (!appt) notFound(); // RLS also hides other businesses' appointments

  const currency = appt.currency || currencyOf(business);
  const money = (cents: number) => formatMoney(cents, currency, lang);
  const back = `/agenda/${appt.id}`;
  // Offer active services and professionals, plus whatever this appointment already uses.
  const serviceOptions = (services ?? []).filter((s) => s.active || s.id === appt.service_id);
  const staffOptions = (staff ?? []).filter((s) => s.active || s.id === appt.staff_id);
  const sameService = serviceOptions.some((s) => s.id === appt.service_id);

  const statusLabel =
    appt.status === 'confirmed'
      ? t('status.confirmed')
      : appt.status === 'cancelled'
        ? t('status.cancelled')
        : isLiveAppointment(appt)
          ? t('status.pending_payment')
          : t('status.expired');

  return (
    <div className="tf-rise max-w-lg">
      <Link
        href={`/agenda?date=${appt.date}`}
        className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-caramel transition hover:text-terracotta"
      >
        <ArrowLeft size={14} aria-hidden />
        {t('nav.agenda')}
      </Link>
      <h1 className="mt-1 font-serif text-2xl font-semibold text-espresso">{t('appt.edit.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">
        {appt.guest_name} — {appt.date}, {normalizeSlot(appt.start_time)}–{normalizeSlot(appt.end_time)}
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-linen bg-white p-5 text-sm shadow-card sm:grid-cols-4">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-espresso/50">{t('common.status')}</dt>
          <dd className="mt-0.5 font-medium text-espresso">{statusLabel}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-espresso/50">{t('common.price')}</dt>
          <dd className="tabular mt-0.5 font-medium text-espresso">{money(appt.price_cents)}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-espresso/50">{t('pay.paidOnline')}</dt>
          <dd className="tabular mt-0.5 font-medium text-espresso">
            {appt.paid_cents > 0 ? money(appt.paid_cents) : t(`pay.status.${appt.payment_status}`)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wider text-espresso/50">{t('pay.dueOnSite')}</dt>
          <dd className="tabular mt-0.5 font-medium text-espresso">
            {money(Math.max(0, appt.price_cents - appt.paid_cents))}
          </dd>
        </div>
      </dl>

      <form
        action={updateAppointment.bind(null, appt.id)}
        className="mt-4 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
      >
        <AppointmentFields
          t={t}
          lang={lang}
          currency={currency}
          services={serviceOptions}
          staff={staffOptions}
          stepMinutes={business.slot_interval_minutes ?? 15}
          keepService={
            sameService
              ? undefined
              : `${appt.service_name} · ${t('appt.minutes', { n: String(appt.duration_minutes) })}`
          }
          defaults={{
            serviceId: sameService ? appt.service_id ?? '' : '',
            staffId: appt.staff_id,
            date: appt.date,
            time: normalizeSlot(appt.start_time),
            name: appt.guest_name,
            phone: appt.guest_phone,
            email: appt.guest_email,
            notes: appt.notes ?? '',
          }}
        />
        <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
          {t('form.save')}
        </button>
      </form>

      <div className="mt-4 rounded-2xl border border-linen bg-white p-5 shadow-card">
        {appt.status === 'cancelled' ? (
          <form action={setAppointmentStatus.bind(null, appt.id, 'confirmed', back)}>
            <button className="min-h-11 rounded-lg border border-leaf px-4 py-2 text-sm font-semibold text-leaf transition hover:bg-leaf hover:text-cream">
              {t('bookings.reconfirm')}
            </button>
          </form>
        ) : (
          <form action={setAppointmentStatus.bind(null, appt.id, 'cancelled', back)}>
            <button className="min-h-11 rounded-lg border border-wine px-4 py-2 text-sm font-semibold text-wine transition hover:bg-wine hover:text-cream">
              {t('appt.cancel')}
            </button>
          </form>
        )}
        <p className="mt-2 text-xs text-espresso/50">
          {appt.paid_cents > 0 ? t('appt.cancelPaidNote') : t('appt.cancelNote')}
        </p>
      </div>
    </div>
  );
}
