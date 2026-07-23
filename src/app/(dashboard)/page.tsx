import Link from 'next/link';
import { CalendarPlus, Mail, Phone, Search, StickyNote } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { setBookingStatus } from '@/app/actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import type { Booking, Restaurant } from '@/lib/types';

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string; q?: string }>;
}) {
  const { view, error, q } = await searchParams;
  const showPast = view === 'past';
  const search = (q ?? '').trim().slice(0, 80);

  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  const t = getT(asLang(restaurant?.language));
  const today = restaurant
    ? nowInTimezone(restaurant.timezone).date
    : new Date().toISOString().slice(0, 10);

  let query = supabase.from('bookings').select('*');
  if (search) query = query.ilike('guest_name', `%${search}%`);
  const [{ data: bookings }, { data: statRows }] = await Promise.all([
    (showPast
      ? query.lt('date', today).order('date', { ascending: false }).order('time_slot', { ascending: false }).limit(200)
      : query.gte('date', today).order('date', { ascending: true }).order('time_slot', { ascending: true })
    ).returns<Booking[]>(),
    supabase
      .from('bookings')
      .select('date, party_size')
      .eq('status', 'confirmed')
      .gte('date', today)
      .returns<Pick<Booking, 'date' | 'party_size'>[]>(),
  ]);

  const todayRows = (statRows ?? []).filter((b) => b.date === today);
  const stats = [
    { label: t('stats.bookingsToday'), value: todayRows.length },
    { label: t('stats.coversToday'), value: todayRows.reduce((s, b) => s + b.party_size, 0) },
    { label: t('stats.upcoming'), value: (statRows ?? []).length },
  ];

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">
          {showPast ? t('bookings.past') : t('bookings.upcoming')}
        </h1>
        <div className="flex gap-1 rounded-full border border-linen bg-white p-1 text-sm shadow-card">
          <Link
            href={search ? `/?q=${encodeURIComponent(search)}` : '/'}
            className={`min-h-9 rounded-full px-4 py-1.5 font-medium transition ${
              !showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.upcoming')}
          </Link>
          <Link
            href={search ? `/?view=past&q=${encodeURIComponent(search)}` : '/?view=past'}
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
            <p className="text-xs font-semibold uppercase tracking-wider text-espresso/50">
              {s.label}
            </p>
            <p className="tabular mt-1 font-serif text-3xl font-semibold text-espresso">
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <form method="GET" action="/" className="relative mt-6 max-w-sm">
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
              <th className="px-4 py-3.5">{t('bookings.date')}</th>
              <th className="px-4 py-3.5">{t('bookings.time')}</th>
              <th className="px-4 py-3.5">{t('bookings.party')}</th>
              <th className="px-4 py-3.5">{t('bookings.table')}</th>
              <th className="px-4 py-3.5">{t('bookings.contact')}</th>
              <th className="px-4 py-3.5">{t('bookings.notes')}</th>
              <th className="px-4 py-3.5">{t('bookings.status')}</th>
              <th className="px-4 py-3.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-linen/60">
            {(bookings ?? []).map((b) => (
              <tr
                key={b.id}
                className={`transition-colors hover:bg-sand/30 ${
                  b.status === 'cancelled' ? 'text-espresso/40' : ''
                }`}
              >
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-xs font-semibold ${
                        b.status === 'cancelled'
                          ? 'bg-sand text-espresso/40'
                          : 'bg-caramel/20 text-terracotta'
                      }`}
                    >
                      {initials(b.guest_name)}
                    </span>
                    <span className="font-medium">{b.guest_name}</span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5">{b.date}</td>
                <td className="px-4 py-3.5 font-medium">{normalizeSlot(b.time_slot)}</td>
                <td className="px-4 py-3.5">{b.party_size}</td>
                <td className="px-4 py-3.5">
                  {b.table_number ? (
                    <span className="rounded-md bg-sand px-2 py-0.5 text-xs font-semibold text-espresso/70">
                      {b.table_number}
                    </span>
                  ) : (
                    <span aria-hidden>—</span>
                  )}
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-1.5">
                    <Phone size={12} aria-hidden className="text-espresso/35" />
                    {b.guest_phone || '—'}
                  </div>
                  {b.guest_email && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-espresso/50">
                      <Mail size={12} aria-hidden className="text-espresso/35" />
                      {b.guest_email}
                    </div>
                  )}
                </td>
                <td className="max-w-44 px-4 py-3.5 text-xs">
                  {b.notes && (
                    <span className="flex items-start gap-1.5">
                      <StickyNote size={12} aria-hidden className="mt-0.5 flex-none text-caramel" />
                      {b.notes}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3.5">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      b.status === 'confirmed'
                        ? 'bg-leaf/15 text-leaf'
                        : 'bg-espresso/10 text-espresso/50'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 rounded-full ${
                        b.status === 'confirmed' ? 'bg-leaf' : 'bg-espresso/40'
                      }`}
                    />
                    {t(b.status === 'confirmed' ? 'status.confirmed' : 'status.cancelled')}
                  </span>
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-espresso/40">
                    {t(b.source === 'widget' ? 'source.widget' : 'source.manual')}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/bookings/${b.id}/edit`}
                      className="min-h-11 content-center text-xs font-semibold text-caramel transition hover:text-terracotta"
                    >
                      {t('bookings.edit')}
                    </Link>
                    {b.status === 'confirmed' ? (
                      <form action={setBookingStatus.bind(null, b.id, 'cancelled')}>
                        <button className="min-h-11 text-xs font-semibold text-wine transition hover:opacity-70">
                          {t('bookings.cancel')}
                        </button>
                      </form>
                    ) : (
                      <form action={setBookingStatus.bind(null, b.id, 'confirmed')}>
                        <button className="min-h-11 text-xs font-semibold text-leaf transition hover:opacity-70">
                          {t('bookings.reconfirm')}
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {(bookings ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-espresso/40">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                      <CalendarPlus size={24} aria-hidden className="text-caramel" />
                    </span>
                    <p>{showPast ? t('bookings.empty.past') : t('bookings.empty.upcoming')}</p>
                    {!showPast && (
                      <Link
                        href="/bookings/new"
                        className="mt-1 rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
                      >
                        {t('nav.add')}
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-espresso/50">{t('bookings.cancelNote')}</p>
    </div>
  );
}
