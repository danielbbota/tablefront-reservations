import Link from 'next/link';
import { CalendarPlus, Mail, Phone, Search, StickyNote } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { setAppointmentStatus } from '@/app/appointments-actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { isLiveAppointment } from '@/lib/appointments/slots';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { currencyOf, type Appointment, type Staff } from '@/lib/types';

export default async function AppointmentsListPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; q?: string }>;
}) {
  const { view, error, q } = await searchParams;
  const showPast = view === 'past';
  const search = (q ?? '').trim().slice(0, 80);

  const { supabase, business } = await requireBusiness('appointments');
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);
  const today = nowInTimezone(business.timezone).date;

  let query = supabase.from('appointments').select('*');
  if (search) query = query.ilike('guest_name', `%${search}%`);
  const [{ data: appointments }, { data: statRows }, { data: staff }] = await Promise.all([
    (showPast
      ? query.lt('date', today).order('date', { ascending: false }).order('start_time', { ascending: false }).limit(200)
      : query.gte('date', today).order('date', { ascending: true }).order('start_time', { ascending: true })
    ).returns<Appointment[]>(),
    supabase
      .from('appointments')
      .select('date, price_cents')
      .eq('status', 'confirmed')
      .gte('date', today)
      .returns<Pick<Appointment, 'date' | 'price_cents'>[]>(),
    supabase.from('staff').select('*').returns<Staff[]>(),
  ]);

  const staffName = new Map((staff ?? []).map((s) => [s.id, s.name]));
  const todayRows = (statRows ?? []).filter((a) => a.date === today);
  const stats = [
    { label: t('appt.stats.today'), value: String(todayRows.length) },
    {
      label: t('agenda.stats.revenue'),
      value: formatMoney(
        todayRows.reduce((sum, a) => sum + a.price_cents, 0),
        currency,
        lang
      ),
    },
    { label: t('stats.upcoming'), value: String((statRows ?? []).length) },
  ];

  const now = new Date();
  const back = showPast ? '/agenda/list?view=past' : '/agenda/list';
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');

  /** Label + colours for the booking status, including holds. */
  const statusOf = (a: Appointment) => {
    if (a.status === 'confirmed') return { label: t('status.confirmed'), tone: 'ok' as const };
    if (a.status === 'pending_payment') {
      return isLiveAppointment(a, now)
        ? { label: t('status.pending_payment'), tone: 'wait' as const }
        : { label: t('status.expired'), tone: 'off' as const };
    }
    return { label: t('status.cancelled'), tone: 'off' as const };
  };
  const TONE = {
    ok: { pill: 'bg-leaf/15 text-leaf', dot: 'bg-leaf' },
    wait: { pill: 'bg-caramel/20 text-terracotta', dot: 'bg-caramel' },
    off: { pill: 'bg-espresso/10 text-espresso/50', dot: 'bg-espresso/40' },
  };

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">
          {showPast ? t('appt.list.past') : t('appt.list.upcoming')}
        </h1>
        <div className="flex gap-1 rounded-full border border-linen bg-white p-1 text-sm shadow-card">
          <Link
            href={search ? `/agenda/list?q=${encodeURIComponent(search)}` : '/agenda/list'}
            className={`min-h-9 rounded-full px-4 py-1.5 font-medium transition ${
              !showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.upcoming')}
          </Link>
          <Link
            href={
              search ? `/agenda/list?view=past&q=${encodeURIComponent(search)}` : '/agenda/list?view=past'
            }
            className={`min-h-9 rounded-full px-4 py-1.5 font-medium transition ${
              showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.past')}
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((s, i) => (
          <div
            key={s.label}
            className="tf-rise rounded-2xl border border-linen bg-white p-5 shadow-card"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-espresso/50">{s.label}</p>
            <p className="tabular mt-1 font-serif text-3xl font-semibold text-espresso">{s.value}</p>
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <form method="GET" action="/agenda/list" className="relative mt-6 max-w-sm">
        {showPast && <input type="hidden" name="view" value="past" />}
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-espresso/40"
        />
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder={t('appt.search')}
          aria-label={t('appt.search')}
          className="min-h-11 w-full rounded-full border border-linen bg-white py-2.5 pl-10 pr-4 text-sm shadow-card focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
        />
      </form>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-linen bg-white shadow-card">
        <table className="w-full text-left text-sm text-espresso">
          <thead className="border-b border-linen bg-sand/50 text-xs font-semibold uppercase tracking-wider text-espresso/60">
            <tr>
              <th className="px-4 py-3.5">{t('appt.client')}</th>
              <th className="px-4 py-3.5">{t('bookings.date')}</th>
              <th className="px-4 py-3.5">{t('bookings.time')}</th>
              <th className="px-4 py-3.5">{t('appt.service')}</th>
              <th className="px-4 py-3.5">{t('appt.staff')}</th>
              <th className="px-4 py-3.5">{t('common.price')}</th>
              <th className="px-4 py-3.5">{t('bookings.contact')}</th>
              <th className="px-4 py-3.5">{t('bookings.status')}</th>
              <th className="px-4 py-3.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-linen/60">
            {(appointments ?? []).map((a) => {
              const status = statusOf(a);
              const faded = status.tone === 'off';
              return (
                <tr
                  key={a.id}
                  className={`transition-colors hover:bg-sand/30 ${faded ? 'text-espresso/40' : ''}`}
                >
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                          faded ? 'bg-sand text-espresso/40' : 'bg-caramel/20 text-terracotta'
                        }`}
                      >
                        {initials(a.guest_name)}
                      </span>
                      <div className="min-w-0">
                        <span className="font-medium">{a.guest_name}</span>
                        {a.notes && (
                          <span className="mt-0.5 flex max-w-44 items-start gap-1.5 text-xs text-espresso/50">
                            <StickyNote size={12} aria-hidden className="mt-0.5 flex-none text-caramel" />
                            {a.notes}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5">{a.date}</td>
                  <td className="whitespace-nowrap px-4 py-3.5 font-medium">
                    {normalizeSlot(a.start_time)}–{normalizeSlot(a.end_time)}
                  </td>
                  <td className="px-4 py-3.5">{a.service_name}</td>
                  <td className="px-4 py-3.5">{staffName.get(a.staff_id) ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3.5">
                    {formatMoney(a.price_cents, a.currency || currency, lang)}
                    {a.paid_cents > 0 && (
                      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-leaf">
                        {t('pay.paidOnline')}: {formatMoney(a.paid_cents, a.currency || currency, lang)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-1.5">
                      <Phone size={12} aria-hidden className="text-espresso/35" />
                      {a.guest_phone || '—'}
                    </div>
                    {a.guest_email && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-espresso/50">
                        <Mail size={12} aria-hidden className="text-espresso/35" />
                        {a.guest_email}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[status.tone].pill}`}
                    >
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONE[status.tone].dot}`} />
                      {status.label}
                    </span>
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-espresso/40">
                      {t(a.source === 'widget' ? 'source.widget' : 'source.manual')}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/agenda/${a.id}`}
                        className="min-h-11 content-center text-xs font-semibold text-caramel transition hover:text-terracotta"
                      >
                        {t('common.edit')}
                      </Link>
                      {a.status === 'cancelled' ? (
                        <form action={setAppointmentStatus.bind(null, a.id, 'confirmed', back)}>
                          <button className="min-h-11 text-xs font-semibold text-leaf transition hover:opacity-70">
                            {t('bookings.reconfirm')}
                          </button>
                        </form>
                      ) : (
                        <form action={setAppointmentStatus.bind(null, a.id, 'cancelled', back)}>
                          <button className="min-h-11 text-xs font-semibold text-wine transition hover:opacity-70">
                            {t('bookings.cancel')}
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {(appointments ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-espresso/40">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                      <CalendarPlus size={24} aria-hidden className="text-caramel" />
                    </span>
                    <p>{showPast ? t('appt.empty.past') : t('appt.empty.upcoming')}</p>
                    {!showPast && (
                      <Link
                        href="/agenda/new"
                        className="mt-1 rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
                      >
                        {t('nav.appts.new')}
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-espresso/50">{t('appt.cancelNote')}</p>
    </div>
  );
}
