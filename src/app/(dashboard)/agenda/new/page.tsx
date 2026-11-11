import Link from 'next/link';
import { requireBusiness } from '@/lib/business';
import { createManualAppointment } from '@/app/appointments-actions';
import { isRealDate, UUID_RE } from '@/lib/appointments/data';
import { nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import { currencyOf, type Service, type Staff } from '@/lib/types';
import AppointmentFields from '../appointment-fields';

export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; date?: string; time?: string; staff?: string }>;
}) {
  const { error, date, time, staff: staffParam } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  const lang = asLang(business.language);
  const t = getT(lang);

  const [{ data: services }, { data: staff }] = await Promise.all([
    supabase.from('services').select('*').eq('active', true).order('sort').order('name').returns<Service[]>(),
    supabase.from('staff').select('*').eq('active', true).order('sort').order('name').returns<Staff[]>(),
  ]);
  const ready = (services ?? []).length > 0 && (staff ?? []).length > 0;

  return (
    <div className="tf-rise max-w-lg">
      <h1 className="font-serif text-2xl font-semibold text-espresso">{t('appt.new.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">{t('appt.new.subtitle')}</p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      {!ready ? (
        <div className="mt-6 rounded-2xl border border-linen bg-white p-6 text-sm text-espresso/70 shadow-card">
          <p>{t('agenda.setup')}</p>
          <div className="mt-4 flex gap-2">
            <Link
              href="/services"
              className="rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
            >
              {t('nav.services')}
            </Link>
            <Link
              href="/team"
              className="rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
            >
              {t('nav.team')}
            </Link>
          </div>
        </div>
      ) : (
        <form
          action={createManualAppointment}
          className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
        >
          <AppointmentFields
            t={t}
            lang={lang}
            currency={currencyOf(business)}
            services={services ?? []}
            staff={staff ?? []}
            stepMinutes={business.slot_interval_minutes ?? 15}
            defaults={{
              date: isRealDate(date) ? date : nowInTimezone(business.timezone).date,
              time: time && /^\d{2}:\d{2}$/.test(time) ? time : undefined,
              staffId: staffParam && UUID_RE.test(staffParam) ? staffParam : undefined,
            }}
          />
          <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
            {t('appt.create')}
          </button>
        </form>
      )}
    </div>
  );
}
