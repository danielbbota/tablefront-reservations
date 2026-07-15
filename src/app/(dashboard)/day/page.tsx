import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase/server';
import { setServiceStatus } from '@/app/actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { asLang, getT, LOCALE } from '@/lib/i18n';
import type { Booking, Restaurant, ServiceStatus } from '@/lib/types';
import DayControls from './day-controls';

const STATUS_STYLE: Record<ServiceStatus, { on: string; off: string }> = {
  arrived: {
    on: 'bg-caramel text-espresso border-caramel',
    off: 'border-linen text-espresso/50 hover:border-caramel hover:text-espresso',
  },
  seated: {
    on: 'bg-leaf text-cream border-leaf',
    off: 'border-linen text-espresso/50 hover:border-leaf hover:text-espresso',
  },
  no_show: {
    on: 'bg-wine text-cream border-wine',
    off: 'border-linen text-espresso/50 hover:border-wine hover:text-espresso',
  },
};

export default async function DayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const { date: dateParam, error } = await searchParams;

  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  if (!restaurant) return null;
  const lang = asLang(restaurant.language);
  const t = getT(lang);

  const today = nowInTimezone(restaurant.timezone).date;
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : today;

  const { data: bookings } = await supabase
    .from('bookings')
    .select('*')
    .eq('date', date)
    .order('time_slot', { ascending: true })
    .returns<Booking[]>();

  const active = (bookings ?? []).filter((b) => b.status === 'confirmed');
  const cancelled = (bookings ?? []).filter((b) => b.status === 'cancelled');
  const totalCovers = active.reduce((sum, b) => sum + b.party_size, 0);

  const bySlot = new Map<string, Booking[]>();
  for (const b of active) {
    const key = normalizeSlot(b.time_slot);
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key)!.push(b);
  }

  const [y, m, d] = date.split('-').map(Number);
  const dateLabel = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

  const statusBtn = (b: Booking, status: ServiceStatus, label: string) => {
    const s = STATUS_STYLE[status];
    const on = b.service_status === status;
    return (
      <form action={setServiceStatus.bind(null, b.id, status, date)}>
        <button
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${on ? s.on : s.off}`}
        >
          {label}
        </button>
      </form>
    );
  };

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-semibold capitalize text-espresso">
            {dateLabel}
            {date === today && (
              <span className="ml-3 align-middle rounded-full bg-caramel/20 px-3 py-1 text-xs font-sans font-semibold uppercase tracking-wide text-terracotta">
                {t('day.today')}
              </span>
            )}
          </h1>
          <p className="mt-1.5 text-sm text-espresso/60">
            {active.length} {t('day.bookings')} · {totalCovers} {t('day.covers')}
          </p>
        </div>
        <DayControls date={date} todayLabel={t('day.today')} />
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">{error}</p>
      )}

      {active.length === 0 && (
        <div className="mt-8 rounded-2xl border border-linen bg-white p-12 text-center text-espresso/40">
          {t('day.empty')}
        </div>
      )}

      <div className="mt-6 space-y-6">
        {Array.from(bySlot.entries()).map(([slot, slotBookings], i) => (
          <section
            key={slot}
            className="tf-rise overflow-hidden rounded-2xl border border-linen bg-white shadow-sm"
            style={{ animationDelay: `${Math.min(i * 60, 300)}ms` }}
          >
            <header className="flex items-baseline justify-between border-b border-linen bg-sand/50 px-5 py-3">
              <span className="font-serif text-lg font-semibold text-espresso">{slot}</span>
              <span className="text-xs font-medium text-espresso/60">
                {slotBookings.reduce((sum, b) => sum + b.party_size, 0)} {t('day.covers')}
              </span>
            </header>
            <ul className="divide-y divide-linen/60">
              {slotBookings.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-sand/30"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-espresso">
                      {b.guest_name}
                      <span className="ml-2 text-espresso/50">× {b.party_size}</span>
                      {b.table_number && (
                        <span className="ml-2 rounded bg-sand px-1.5 py-0.5 text-xs font-semibold text-espresso/70">
                          {t('bookings.table')} {b.table_number}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-espresso/50">
                      {b.guest_phone}
                      {b.notes ? ` · ${b.notes}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBtn(b, 'arrived', t('day.arrived'))}
                    {statusBtn(b, 'seated', t('day.seated'))}
                    {statusBtn(b, 'no_show', t('day.noshow'))}
                    <Link
                      href={`/bookings/${b.id}/edit`}
                      className="ml-1 text-xs font-semibold text-caramel transition hover:text-terracotta"
                    >
                      {t('bookings.edit')}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {cancelled.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-espresso/40">
            {t('status.cancelled')}
          </h2>
          <ul className="mt-2 space-y-1">
            {cancelled.map((b) => (
              <li key={b.id} className="text-sm text-espresso/40 line-through">
                {normalizeSlot(b.time_slot)} — {b.guest_name} × {b.party_size}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
