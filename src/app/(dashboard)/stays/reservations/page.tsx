import Link from 'next/link';
import { CalendarPlus, Mail, Phone, Search } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { isLive } from '@/lib/stays/availability';
import { daysBetween } from '@/lib/stays/dates';
import { guestLabel, isChannelSource, SOURCE_COLORS, sourceLabel } from '@/lib/stays/display';
import { setStayReservationStatus } from '@/app/stays-actions';
import type { StayReservation, StayUnit } from '@/lib/types';

export default async function StayReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; q?: string }>;
}) {
  const { view, error, q } = await searchParams;
  const showPast = view === 'past';
  const search = (q ?? '').trim().slice(0, 80);

  const { supabase, business } = await requireBusiness('stays');
  const lang = asLang(business.language);
  const t = getT(lang);
  const today = nowInTimezone(business.timezone).date;

  let query = supabase.from('stay_reservations').select('*');
  if (search) query = query.ilike('guest_name', `%${search}%`);
  const [{ data: reservations }, { data: units }] = await Promise.all([
    (showPast
      ? query.lt('check_out', today).order('check_in', { ascending: false }).limit(200)
      : query.gte('check_out', today).order('check_in', { ascending: true })
    ).returns<StayReservation[]>(),
    supabase.from('stay_units').select('id, name').returns<Pick<StayUnit, 'id' | 'name'>[]>(),
  ]);
  const unitName = new Map((units ?? []).map((u) => [u.id, u.name]));
  const now = new Date();

  const base = '/stays/reservations';
  const tabHref = (past: boolean) => {
    const params = new URLSearchParams();
    if (past) params.set('view', 'past');
    if (search) params.set('q', search);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const statusOf = (r: StayReservation) => {
    if (r.status === 'confirmed') return { key: 'status.confirmed' as const, tone: 'leaf' };
    if (r.status === 'cancelled') return { key: 'status.cancelled' as const, tone: 'muted' };
    return isLive(r, now)
      ? { key: 'status.pending_payment' as const, tone: 'caramel' }
      : { key: 'status.expired' as const, tone: 'muted' };
  };
  const tones: Record<string, string> = {
    leaf: 'bg-leaf/15 text-leaf',
    caramel: 'bg-caramel/20 text-terracotta',
    muted: 'bg-espresso/10 text-espresso/50',
  };

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">
          {showPast ? t('stay.list.past') : t('stay.list.upcoming')}
        </h1>
        <div className="flex gap-1 rounded-full border border-linen bg-white p-1 text-sm shadow-card">
          <Link
            href={tabHref(false)}
            className={`min-h-9 rounded-full px-4 py-1.5 font-medium transition ${
              !showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.upcoming')}
          </Link>
          <Link
            href={tabHref(true)}
            className={`min-h-9 rounded-full px-4 py-1.5 font-medium transition ${
              showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.past')}
          </Link>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <form method="GET" action={base} className="relative mt-6 max-w-sm">
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
          placeholder={t('bookings.search')}
          aria-label={t('bookings.search')}
          className="min-h-11 w-full rounded-full border border-linen bg-white py-2.5 pl-10 pr-4 text-sm shadow-card focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
        />
      </form>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-linen bg-white shadow-card">
        <table className="w-full text-left text-sm text-espresso">
          <thead className="border-b border-linen bg-sand/50 text-xs font-semibold uppercase tracking-wider text-espresso/60">
            <tr>
              <th className="px-4 py-3.5">{t('bookings.guest')}</th>
              <th className="px-4 py-3.5">{t('stay.unit')}</th>
              <th className="px-4 py-3.5">{t('stay.checkIn')}</th>
              <th className="px-4 py-3.5">{t('stay.checkOut')}</th>
              <th className="px-4 py-3.5">{t('stay.nights')}</th>
              <th className="px-4 py-3.5">{t('stay.guests')}</th>
              <th className="px-4 py-3.5">{t('common.total')}</th>
              <th className="px-4 py-3.5">{t('bookings.contact')}</th>
              <th className="px-4 py-3.5">{t('bookings.status')}</th>
              <th className="px-4 py-3.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-linen/60">
            {(reservations ?? []).map((r) => {
              const status = statusOf(r);
              const channel = isChannelSource(r.source);
              const faded = r.status === 'cancelled' || status.key === 'status.expired';
              return (
                <tr
                  key={r.id}
                  className={`transition-colors hover:bg-sand/30 ${faded ? 'text-espresso/40' : ''}`}
                >
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className="h-8 w-1.5 flex-none rounded-full"
                        style={{ background: faded ? '#ddd3be' : SOURCE_COLORS[r.source].bg }}
                      />
                      <div>
                        <span className="font-medium">{guestLabel(r, t)}</span>
                        <div className="text-[10px] uppercase tracking-wide text-espresso/45">
                          {sourceLabel(r.source, t)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">{unitName.get(r.unit_id) ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3.5">{r.check_in}</td>
                  <td className="whitespace-nowrap px-4 py-3.5">{r.check_out}</td>
                  <td className="px-4 py-3.5">{daysBetween(r.check_in, r.check_out)}</td>
                  <td className="px-4 py-3.5">{channel ? '—' : r.guests}</td>
                  <td className="whitespace-nowrap px-4 py-3.5">
                    {r.total_cents > 0 ? formatMoney(r.total_cents, r.currency, lang) : '—'}
                    {r.paid_cents > 0 && (
                      <div className="text-[11px] text-leaf">
                        {t('pay.paidOnline')}: {formatMoney(r.paid_cents, r.currency, lang)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    {r.guest_phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone size={12} aria-hidden className="text-espresso/35" />
                        {r.guest_phone}
                      </div>
                    )}
                    {r.guest_email && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-espresso/50">
                        <Mail size={12} aria-hidden className="text-espresso/35" />
                        {r.guest_email}
                      </div>
                    )}
                    {!r.guest_phone && !r.guest_email && <span aria-hidden>—</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tones[status.tone]}`}
                    >
                      {t(status.key)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`${base}/${r.id}`}
                        className="min-h-11 content-center text-xs font-semibold text-caramel transition hover:text-terracotta"
                      >
                        {t('bookings.edit')}
                      </Link>
                      {!channel &&
                        (r.status === 'cancelled' ? (
                          <form action={setStayReservationStatus.bind(null, r.id, 'confirmed')}>
                            <button className="min-h-11 text-xs font-semibold text-leaf transition hover:opacity-70">
                              {t('bookings.reconfirm')}
                            </button>
                          </form>
                        ) : (
                          <form action={setStayReservationStatus.bind(null, r.id, 'cancelled')}>
                            <button className="min-h-11 text-xs font-semibold text-wine transition hover:opacity-70">
                              {t('bookings.cancel')}
                            </button>
                          </form>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {(reservations ?? []).length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-espresso/40">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                      <CalendarPlus size={24} aria-hidden className="text-caramel" />
                    </span>
                    <p>{showPast ? t('stay.list.empty.past') : t('stay.list.empty.upcoming')}</p>
                    {!showPast && (
                      <Link
                        href="/stays/new"
                        className="mt-1 rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
                      >
                        {t('nav.stays.new')}
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-espresso/50">{t('stay.list.note')}</p>
    </div>
  );
}
