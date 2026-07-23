import Link from 'next/link';
import { CalendarX2, Pencil } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { setServiceStatus } from '@/app/actions';
import { normalizeSlot, nowInTimezone, resolveMaxCovers } from '@/lib/availability';
import { asLang, getT, LOCALE } from '@/lib/i18n';
import type { Booking, CapacityRule, Restaurant, ServiceStatus } from '@/lib/types';
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

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

  const weekStart = addDays(date, -3);
  const weekEnd = addDays(date, 3);

  const [{ data: bookings }, { data: rules }, { data: weekRows }] = await Promise.all([
    supabase
      .from('bookings')
      .select('*')
      .eq('date', date)
      .order('time_slot', { ascending: true })
      .returns<Booking[]>(),
    supabase.from('capacity_rules').select('*').returns<CapacityRule[]>(),
    supabase
      .from('bookings')
      .select('date')
      .eq('status', 'confirmed')
      .gte('date', weekStart)
      .lte('date', weekEnd)
      .returns<Pick<Booking, 'date'>[]>(),
  ]);

  const weekCounts = new Map<string, number>();
  for (const r of weekRows ?? []) {
    weekCounts.set(r.date, (weekCounts.get(r.date) ?? 0) + 1);
  }
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i);
    const [y, m, dd] = d.split('-').map(Number);
    const label = new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString(LOCALE[lang], {
      weekday: 'short',
      timeZone: 'UTC',
    });
    return { date: d, label, day: dd, count: weekCounts.get(d) ?? 0 };
  });

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
          aria-pressed={on}
          className={`min-h-9 rounded-full border px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${on ? s.on : s.off}`}
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
          <h1 className="font-serif text-[1.7rem] font-semibold capitalize tracking-tight text-espresso">
            {dateLabel}
            {date === today && (
              <span className="ml-3 inline-block translate-y-[-3px] rounded-full bg-caramel/20 px-3 py-1 align-middle font-sans text-xs font-semibold uppercase tracking-wide text-terracotta">
                {t('day.today')}
              </span>
            )}
          </h1>
          <p className="tabular mt-1.5 text-sm text-espresso/60">
            {active.length} {t('day.bookings')} · {totalCovers} {t('day.covers')}
          </p>
        </div>
        <DayControls date={date} todayLabel={t('day.today')} />
      </div>

      <nav aria-label={t('nav.day')} className="mt-6 grid grid-cols-7 gap-1.5 sm:max-w-md">
        {weekDays.map((w) => {
          const selected = w.date === date;
          return (
            <Link
              key={w.date}
              href={`/day?date=${w.date}`}
              aria-current={selected ? 'date' : undefined}
              className={`tf-lift flex min-h-11 flex-col items-center rounded-xl border px-1 py-2 text-center transition-colors ${
                selected
                  ? 'border-espresso bg-espresso text-cream shadow-card'
                  : 'border-linen bg-white text-espresso/70 hover:border-caramel'
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                {w.label}
              </span>
              <span className="tabular font-serif text-base font-semibold leading-tight">
                {w.day}
              </span>
              <span
                className={`tabular text-[10px] font-semibold ${
                  selected ? 'text-caramel' : w.count ? 'text-terracotta' : 'opacity-40'
                }`}
              >
                {w.count || '·'}
              </span>
            </Link>
          );
        })}
      </nav>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      {active.length === 0 && (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-linen bg-white p-14 text-center text-espresso/40 shadow-card">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
            <CalendarX2 size={24} aria-hidden className="text-caramel" />
          </span>
          {t('day.empty')}
        </div>
      )}

      <div className="mt-6 space-y-6">
        {Array.from(bySlot.entries()).map(([slot, slotBookings], i) => {
          const cap = resolveMaxCovers(restaurant, rules ?? [], date, slot);
          const covers = slotBookings.reduce((sum, b) => sum + b.party_size, 0);
          const pct = cap > 0 ? Math.min(100, Math.round((covers / cap) * 100)) : 100;
          const barColor =
            pct >= 100 ? 'bg-wine' : pct >= 75 ? 'bg-terracotta' : 'bg-caramel';
          return (
            <section
              key={slot}
              className="tf-rise overflow-hidden rounded-2xl border border-linen bg-white shadow-card"
              style={{ animationDelay: `${Math.min(i * 50, 300)}ms` }}
            >
              <header className="border-b border-linen bg-sand/50 px-5 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="tabular font-serif text-lg font-semibold text-espresso">
                    {slot}
                  </span>
                  <span className="tabular text-xs font-medium text-espresso/60">
                    {covers}/{cap} {t('day.covers')}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={covers}
                  aria-valuemin={0}
                  aria-valuemax={cap}
                  aria-label={`${slot}: ${covers}/${cap}`}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-linen/60"
                >
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
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
                        <span className="tabular ml-2 text-espresso/50">× {b.party_size}</span>
                        {b.table_number && (
                          <span className="ml-2 rounded-md bg-sand px-1.5 py-0.5 text-xs font-semibold text-espresso/70">
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
                        aria-label={t('bookings.edit')}
                        className="ml-1 flex min-h-9 min-w-9 items-center justify-center rounded-full text-caramel transition hover:bg-sand hover:text-terracotta"
                      >
                        <Pencil size={15} aria-hidden />
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
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
