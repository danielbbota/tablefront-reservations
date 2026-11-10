import Link from 'next/link';
import { CalendarX2, Pencil, Plus } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { setAppointmentServiceStatus } from '@/app/appointments-actions';
import { normalizeSlot, nowInTimezone, toHHMM, toMinutes } from '@/lib/availability';
import { isRealDate } from '@/lib/appointments/data';
import { isLiveAppointment, workingWindow } from '@/lib/appointments/slots';
import { asLang, getT, LOCALE } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import {
  currencyOf,
  type Appointment,
  type AppointmentServiceStatus,
  type Staff,
  type StaffTimeOff,
} from '@/lib/types';
import AgendaControls from './agenda-controls';

const STATUS_STYLE: Record<AppointmentServiceStatus, { on: string; off: string }> = {
  arrived: {
    on: 'bg-caramel text-espresso border-caramel',
    off: 'border-linen text-espresso/50 hover:border-caramel hover:text-espresso',
  },
  completed: {
    on: 'bg-leaf text-cream border-leaf',
    off: 'border-linen text-espresso/50 hover:border-leaf hover:text-espresso',
  },
  no_show: {
    on: 'bg-wine text-cream border-wine',
    off: 'border-linen text-espresso/50 hover:border-wine hover:text-espresso',
  },
};

/** Calendar scale: pixels per minute (72px per hour). */
const PPM = 1.2;
const GUTTER = 56;
const COLUMN_MIN = 172;

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const { date: dateParam, error } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);

  const clock = nowInTimezone(business.timezone);
  const today = clock.date;
  const date = isRealDate(dateParam) ? dateParam : today;
  const weekStart = addDays(date, -3);
  const weekEnd = addDays(date, 3);

  const [{ data: staffRows }, { data: dayRows }, { data: weekRows }, { data: offRows }, { count: serviceCount }] =
    await Promise.all([
      supabase.from('staff').select('*').order('sort').order('name').returns<Staff[]>(),
      supabase
        .from('appointments')
        .select('*')
        .eq('date', date)
        .order('start_time', { ascending: true })
        .returns<Appointment[]>(),
      supabase
        .from('appointments')
        .select('date')
        .eq('status', 'confirmed')
        .gte('date', weekStart)
        .lte('date', weekEnd)
        .returns<Pick<Appointment, 'date'>[]>(),
      supabase.from('staff_time_off').select('*').eq('date', date).returns<StaffTimeOff[]>(),
      supabase.from('services').select('id', { count: 'exact', head: true }),
    ]);

  const now = new Date();
  const staff = staffRows ?? [];
  const live = (dayRows ?? []).filter((a) => isLiveAppointment(a, now));
  const cancelled = (dayRows ?? []).filter((a) => a.status === 'cancelled');
  const timeOff = offRows ?? [];

  // One column per active professional, plus anyone inactive who still has
  // an appointment on this day.
  const columns = staff.filter((s) => s.active || live.some((a) => a.staff_id === s.id));
  const staffName = new Map(staff.map((s) => [s.id, s.name]));

  // Visible hours: the earliest opening to the latest closing, stretched to
  // cover any appointment booked outside them.
  const windows = columns
    .map((s) => workingWindow(business, s, date))
    .filter((w): w is { open: number; close: number } => w !== null);
  let startMin = windows.length ? Math.min(...windows.map((w) => w.open)) : 9 * 60;
  let endMin = windows.length ? Math.max(...windows.map((w) => w.close)) : 18 * 60;
  for (const a of live) {
    startMin = Math.min(startMin, toMinutes(a.start_time));
    endMin = Math.max(endMin, toMinutes(a.end_time));
  }
  startMin = Math.floor(startMin / 60) * 60;
  endMin = Math.min(24 * 60, Math.ceil(endMin / 60) * 60);
  const hours = Array.from({ length: (endMin - startMin) / 60 }, (_, i) => startMin + i * 60);
  const gridHeight = (endMin - startMin) * PPM;
  const y = (minutes: number) => (Math.min(endMin, Math.max(startMin, minutes)) - startMin) * PPM;

  const weekCounts = new Map<string, number>();
  for (const r of weekRows ?? []) weekCounts.set(r.date, (weekCounts.get(r.date) ?? 0) + 1);
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i);
    const [yy, mm, dd] = d.split('-').map(Number);
    const label = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString(LOCALE[lang], {
      weekday: 'short',
      timeZone: 'UTC',
    });
    return { date: d, label, day: dd, count: weekCounts.get(d) ?? 0 };
  });

  const [yy, mm, dd] = date.split('-').map(Number);
  const dateLabel = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

  const stats = [
    { label: t('agenda.stats.appointments'), value: String(live.length) },
    {
      label: t('agenda.stats.revenue'),
      value: formatMoney(
        live.filter((a) => a.service_status !== 'no_show').reduce((sum, a) => sum + a.price_cents, 0),
        currency,
        lang
      ),
    },
    {
      label: t('agenda.stats.completed'),
      value: `${live.filter((a) => a.service_status === 'completed').length}/${live.length}`,
    },
  ];

  const statusBtn = (a: Appointment, status: AppointmentServiceStatus, label: string) => {
    const s = STATUS_STYLE[status];
    const on = a.service_status === status;
    return (
      <form action={setAppointmentServiceStatus.bind(null, a.id, status, date)}>
        <button
          aria-pressed={on}
          className={`min-h-9 rounded-full border px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${on ? s.on : s.off}`}
        >
          {label}
        </button>
      </form>
    );
  };

  const needsSetup = staff.length === 0 || !serviceCount;
  const showNow = date === today && clock.minutes >= startMin && clock.minutes <= endMin;

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[1.7rem] font-semibold capitalize tracking-tight text-espresso">
            {dateLabel}
            {date === today && (
              <span className="ml-3 inline-block translate-y-[-3px] rounded-full bg-caramel/20 px-3 py-1 align-middle font-sans text-xs font-semibold uppercase tracking-wide text-terracotta">
                {t('common.today')}
              </span>
            )}
          </h1>
          <p className="mt-1.5 text-sm text-espresso/60">{business.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AgendaControls
            date={date}
            labels={{
              today: t('common.today'),
              previous: t('common.previous'),
              next: t('common.next'),
              pick: t('form.date'),
            }}
          />
          <Link
            href={`/agenda/new?date=${date}`}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-espresso px-4 py-2 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-95"
          >
            <Plus size={16} aria-hidden />
            {t('nav.appts.new')}
          </Link>
        </div>
      </div>

      <nav aria-label={t('nav.agenda')} className="mt-6 grid grid-cols-7 gap-1.5 sm:max-w-md">
        {weekDays.map((w) => {
          const selected = w.date === date;
          return (
            <Link
              key={w.date}
              href={`/agenda?date=${w.date}`}
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
              <span className="tabular font-serif text-base font-semibold leading-tight">{w.day}</span>
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

      {needsSetup ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-linen bg-white p-14 text-center shadow-card">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
            <CalendarX2 size={24} aria-hidden className="text-caramel" />
          </span>
          <p className="max-w-sm text-sm text-espresso/60">{t('agenda.setup')}</p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
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
        <div className="mt-6 overflow-x-auto rounded-2xl border border-linen bg-white shadow-card">
          <div style={{ minWidth: GUTTER + columns.length * COLUMN_MIN }}>
            <div className="flex border-b border-linen bg-sand/50">
              <div style={{ width: GUTTER }} className="flex-none" />
              {columns.map((s) => {
                const count = live.filter((a) => a.staff_id === s.id).length;
                return (
                  <div
                    key={s.id}
                    className="flex min-w-0 flex-1 items-center gap-2.5 border-l border-linen/70 px-3 py-3"
                    style={{ minWidth: COLUMN_MIN }}
                  >
                    <span
                      aria-hidden
                      className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: s.color }}
                    >
                      {s.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 leading-tight">
                      <p className="truncate text-sm font-semibold text-espresso">{s.name}</p>
                      <p className="tabular truncate text-[11px] text-espresso/50">
                        {count} · {s.title || t('agenda.appointments')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="relative flex" style={{ height: gridHeight }}>
              <div style={{ width: GUTTER }} className="relative flex-none">
                {hours.map((h) => (
                  <span
                    key={h}
                    className="tabular absolute right-2 -translate-y-1/2 text-[11px] font-medium text-espresso/45"
                    style={{ top: h === startMin ? 8 : y(h) }}
                  >
                    {toHHMM(h)}
                  </span>
                ))}
              </div>

              {columns.map((s) => {
                const window = workingWindow(business, s, date);
                const offAllDay = timeOff.some((o) => o.staff_id === s.id && !o.start_time);
                const closed: [number, number][] =
                  !window || offAllDay
                    ? [[startMin, endMin]]
                    : [
                        [startMin, window.open],
                        [window.close, endMin],
                        ...timeOff
                          .filter((o) => o.staff_id === s.id && o.start_time && o.end_time)
                          .map((o): [number, number] => [toMinutes(o.start_time!), toMinutes(o.end_time!)]),
                      ];
                return (
                  <div
                    key={s.id}
                    className="relative flex-1 border-l border-linen/70"
                    style={{ minWidth: COLUMN_MIN }}
                  >
                    {hours.map((h) => (
                      <Link
                        key={h}
                        href={`/agenda/new?date=${date}&time=${toHHMM(h)}&staff=${s.id}`}
                        aria-label={`${t('nav.appts.new')} — ${s.name}, ${toHHMM(h)}`}
                        className="absolute inset-x-0 border-t border-linen/60 transition-colors hover:bg-caramel/10"
                        style={{ top: y(h), height: 60 * PPM }}
                      />
                    ))}
                    {closed
                      .filter(([a, b]) => b > a)
                      .map(([a, b], i) => (
                        <div
                          key={i}
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 bg-sand/70"
                          style={{
                            top: y(a),
                            height: y(b) - y(a),
                            backgroundImage:
                              'repeating-linear-gradient(135deg, transparent 0 6px, rgba(26,18,8,0.04) 6px 12px)',
                          }}
                        />
                      ))}
                    {live
                      .filter((a) => a.staff_id === s.id)
                      .map((a) => {
                        const top = y(toMinutes(a.start_time));
                        const height = Math.max(26, y(toMinutes(a.end_time)) - top - 2);
                        const pending = a.status === 'pending_payment';
                        const done = a.service_status === 'completed';
                        const noShow = a.service_status === 'no_show';
                        return (
                          <Link
                            key={a.id}
                            href={`/agenda/${a.id}`}
                            title={`${normalizeSlot(a.start_time)}–${normalizeSlot(a.end_time)} · ${a.guest_name} · ${a.service_name}`}
                            className={`absolute left-1 right-1 z-10 overflow-hidden rounded-lg border-l-4 px-2 py-1 text-[11px] leading-snug text-espresso shadow-card transition hover:brightness-95 ${
                              pending ? 'border border-dashed border-l-4' : ''
                            } ${noShow ? 'opacity-50' : ''}`}
                            style={{
                              top,
                              height,
                              borderLeftColor: s.color,
                              borderColor: pending ? s.color : undefined,
                              backgroundColor: `${s.color}${done ? '14' : '2b'}`,
                            }}
                          >
                            <span className="tabular font-semibold">
                              {normalizeSlot(a.start_time)}–{normalizeSlot(a.end_time)}
                            </span>{' '}
                            <span className={`font-medium ${noShow ? 'line-through' : ''}`}>{a.guest_name}</span>
                            <span className="block truncate text-espresso/60">
                              {pending ? `${t('status.pending_payment')} · ` : ''}
                              {a.service_name}
                            </span>
                          </Link>
                        );
                      })}
                  </div>
                );
              })}

              {showNow && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute right-0 z-20 border-t-2 border-terracotta"
                  style={{ top: y(clock.minutes), left: GUTTER - 6 }}
                >
                  <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-terracotta" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!needsSetup && live.length === 0 && (
        <p className="mt-6 text-center text-sm text-espresso/40">{t('agenda.empty')}</p>
      )}

      {live.length > 0 && (
        <section className="mt-6 overflow-hidden rounded-2xl border border-linen bg-white shadow-card">
          <header className="border-b border-linen bg-sand/50 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-espresso/60">
            {t('agenda.dayList')}
          </header>
          <ul className="divide-y divide-linen/60">
            {live.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-sand/30"
              >
                <div className="min-w-0">
                  <p className="font-medium text-espresso">
                    <span className="tabular mr-2 font-serif text-base font-semibold">
                      {normalizeSlot(a.start_time)}
                    </span>
                    {a.guest_name}
                    <span className="ml-2 rounded-md bg-sand px-1.5 py-0.5 text-xs font-semibold text-espresso/70">
                      {a.service_name}
                    </span>
                    {a.status === 'pending_payment' && (
                      <span className="ml-2 rounded-md bg-caramel/20 px-1.5 py-0.5 text-xs font-semibold text-terracotta">
                        {t('status.pending_payment')}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-espresso/50">
                    {staffName.get(a.staff_id) ?? '—'}
                    {a.guest_phone ? ` · ${a.guest_phone}` : ''}
                    {a.notes ? ` · ${a.notes}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {statusBtn(a, 'arrived', t('appt.arrived'))}
                  {statusBtn(a, 'completed', t('appt.completed'))}
                  {statusBtn(a, 'no_show', t('appt.noShow'))}
                  <Link
                    href={`/agenda/${a.id}`}
                    aria-label={t('common.edit')}
                    className="ml-1 flex min-h-9 min-w-9 items-center justify-center rounded-full text-caramel transition hover:bg-sand hover:text-terracotta"
                  >
                    <Pencil size={15} aria-hidden />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cancelled.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-espresso/40">
            {t('status.cancelled')}
          </h2>
          <ul className="mt-2 space-y-1">
            {cancelled.map((a) => (
              <li key={a.id} className="text-sm text-espresso/40 line-through">
                {normalizeSlot(a.start_time)} — {a.guest_name} · {a.service_name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
