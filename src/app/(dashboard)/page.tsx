import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase/server';
import { setBookingStatus } from '@/app/actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import type { Booking, Restaurant } from '@/lib/types';

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; error?: string }>;
}) {
  const { view, error } = await searchParams;
  const showPast = view === 'past';

  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  const t = getT(asLang(restaurant?.language));
  const today = restaurant
    ? nowInTimezone(restaurant.timezone).date
    : new Date().toISOString().slice(0, 10);

  const query = supabase.from('bookings').select('*');
  const { data: bookings } = await (showPast
    ? query.lt('date', today).order('date', { ascending: false }).order('time_slot', { ascending: false }).limit(200)
    : query.gte('date', today).order('date', { ascending: true }).order('time_slot', { ascending: true })
  ).returns<Booking[]>();

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold text-espresso">
          {showPast ? t('bookings.past') : t('bookings.upcoming')}
        </h1>
        <div className="flex gap-1 rounded-full border border-linen bg-white p-1 text-sm">
          <Link
            href="/"
            className={`rounded-full px-4 py-1.5 font-medium transition ${
              !showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.upcoming')}
          </Link>
          <Link
            href="/?view=past"
            className={`rounded-full px-4 py-1.5 font-medium transition ${
              showPast ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
            }`}
          >
            {t('bookings.tab.past')}
          </Link>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">{error}</p>
      )}

      <div className="mt-5 overflow-x-auto rounded-2xl border border-linen bg-white shadow-sm">
        <table className="w-full text-left text-sm text-espresso">
          <thead className="border-b border-linen bg-sand/50 text-xs font-semibold uppercase tracking-wider text-espresso/60">
            <tr>
              <th className="px-4 py-3.5">{t('bookings.date')}</th>
              <th className="px-4 py-3.5">{t('bookings.time')}</th>
              <th className="px-4 py-3.5">{t('bookings.guest')}</th>
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
              <tr key={b.id} className={`transition-colors hover:bg-sand/30 ${b.status === 'cancelled' ? 'text-espresso/40' : ''}`}>
                <td className="whitespace-nowrap px-4 py-3.5">{b.date}</td>
                <td className="px-4 py-3.5 font-medium">{normalizeSlot(b.time_slot)}</td>
                <td className="px-4 py-3.5 font-medium">{b.guest_name}</td>
                <td className="px-4 py-3.5">{b.party_size}</td>
                <td className="px-4 py-3.5">{b.table_number ?? '—'}</td>
                <td className="px-4 py-3.5">
                  <div>{b.guest_phone}</div>
                  <div className="text-xs text-espresso/50">{b.guest_email}</div>
                </td>
                <td className="max-w-44 px-4 py-3.5 text-xs">{b.notes}</td>
                <td className="px-4 py-3.5">
                  <span
                    className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${
                      b.status === 'confirmed'
                        ? 'bg-leaf/15 text-leaf'
                        : 'bg-espresso/10 text-espresso/50'
                    }`}
                  >
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
                      className="text-xs font-semibold text-caramel transition hover:text-terracotta"
                    >
                      {t('bookings.edit')}
                    </Link>
                    {b.status === 'confirmed' ? (
                      <form action={setBookingStatus.bind(null, b.id, 'cancelled')}>
                        <button className="text-xs font-semibold text-wine transition hover:opacity-70">
                          {t('bookings.cancel')}
                        </button>
                      </form>
                    ) : (
                      <form action={setBookingStatus.bind(null, b.id, 'confirmed')}>
                        <button className="text-xs font-semibold text-leaf transition hover:opacity-70">
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
                <td colSpan={9} className="px-4 py-12 text-center text-espresso/40">
                  {showPast ? t('bookings.empty.past') : t('bookings.empty.upcoming')}
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
