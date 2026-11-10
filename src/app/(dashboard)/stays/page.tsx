import Link from 'next/link';
import { after } from 'next/server';
import { AlertTriangle, CalendarPlus, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { asLang, getT, LOCALE } from '@/lib/i18n';
import { findConflicts, isLive } from '@/lib/stays/availability';
import { addDays, daysBetween, isIsoDate } from '@/lib/stays/dates';
import { guestLabel, SOURCE_COLORS, sourceLabel } from '@/lib/stays/display';
import { anyFeedStale, syncFeeds } from '@/lib/stays/sync';
import { setStayStatus, syncStayChannels } from '@/app/stays-actions';
import type { StayBlock, StayIcalFeed, StayReservation, StayUnit } from '@/lib/types';

const UNIT_COL = 168; // px
const DAY_MIN = 46; // px
const AUTO_SYNC_MINUTES = 15;

export default async function StaysCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    days?: string;
    error?: string;
    synced?: string;
    feeds?: string;
    failed?: string;
  }>;
}) {
  const sp = await searchParams;
  const { supabase, business } = await requireBusiness('stays');
  const lang = asLang(business.language);
  const t = getT(lang);

  const today = nowInTimezone(business.timezone).date;
  const span = sp.days === '30' ? 30 : 14;
  const from = isIsoDate(sp.from) ? sp.from : addDays(today, -1);
  const to = addDays(from, span);

  const [{ data: units }, { data: reservations }, { data: blocks }, { data: feeds }, { data: around }] =
    await Promise.all([
      supabase.from('stay_units').select('*').order('sort').order('name').returns<StayUnit[]>(),
      supabase
        .from('stay_reservations')
        .select('*')
        .neq('status', 'cancelled')
        .lt('check_in', to)
        .gt('check_out', from)
        .order('check_in')
        .returns<StayReservation[]>(),
      supabase
        .from('stay_blocks')
        .select('*')
        .lt('start_date', to)
        .gt('end_date', from)
        .returns<StayBlock[]>(),
      supabase.from('stay_ical_feeds').select('*').returns<StayIcalFeed[]>(),
      supabase
        .from('stay_reservations')
        .select('*')
        .neq('status', 'cancelled')
        .lte('check_in', today)
        .gte('check_out', today)
        .order('guest_name')
        .returns<StayReservation[]>(),
    ]);

  // Opening the calendar keeps the channels fresh: stale feeds are pulled
  // after this response, and show on the next load.
  if ((feeds ?? []).length && anyFeedStale(feeds ?? [], AUTO_SYNC_MINUTES)) {
    after(async () => {
      await syncFeeds(createAdminClient(), { restaurantId: business.id }, AUTO_SYNC_MINUTES);
    });
  }

  const now = new Date();
  const live = (reservations ?? []).filter((r) => isLive(r, now));
  const conflicts = findConflicts(live, now);
  const shownUnits = (units ?? []).filter(
    (u) => u.active || live.some((r) => r.unit_id === u.id)
  );
  const unitName = new Map((units ?? []).map((u) => [u.id, u.name]));

  const liveToday = (around ?? []).filter((r) => isLive(r, now));
  const arrivals = liveToday.filter((r) => r.check_in === today);
  const departures = liveToday.filter((r) => r.check_out === today);
  const inHouse = liveToday.filter((r) => r.check_in <= today && today < r.check_out);
  const activeUnits = (units ?? []).filter((u) => u.active).length;

  const days = Array.from({ length: span }, (_, i) => {
    const date = addDays(from, i);
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return {
      date,
      day: d,
      // pt-PT spells "short" weekdays out ("segunda"): keep three letters.
      weekday: dt
        .toLocaleDateString(LOCALE[lang], { weekday: 'short', timeZone: 'UTC' })
        .replace('.', '')
        .slice(0, 3),
      weekend: dt.getUTCDay() === 0 || dt.getUTCDay() === 6,
      today: date === today,
    };
  });
  const monthLabel = (() => {
    const [y, m, d] = from.split('-').map(Number);
    const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return label.charAt(0).toUpperCase() + label.slice(1);
  })();

  // Double-booked reservations share a row: give each half the height so
  // both stay visible instead of one hiding the other.
  const lane = new Map<string, 0 | 1>();
  for (const unit of units ?? []) {
    live
      .filter((r) => r.unit_id === unit.id && conflicts.has(r.id))
      .forEach((r, i) => lane.set(r.id, i % 2 === 0 ? 0 : 1));
  }

  const href = (nextFrom: string, nextSpan = span) =>
    `/stays?from=${nextFrom}${nextSpan === 30 ? '&days=30' : ''}`;
  const columns = `${UNIT_COL}px repeat(${span}, minmax(${DAY_MIN}px, 1fr))`;

  /** Position of a [start, end) range as a bar from mid-day to mid-day. */
  const bar = (start: string, end: string) => {
    const a = Math.max(daysBetween(from, start) + 0.5, 0);
    const b = Math.min(daysBetween(from, end) + 0.5, span);
    if (b <= a) return null;
    return { left: `${(a / span) * 100}%`, width: `${((b - a) / span) * 100}%` };
  };

  const lastSync = (feeds ?? [])
    .map((f) => f.last_synced_at)
    .filter((v): v is string => !!v)
    .sort()
    .pop();
  const failedFeeds = (feeds ?? []).filter((f) => f.last_status === 'error');

  const stats = [
    { label: t('stay.stats.arrivals'), value: String(arrivals.length) },
    { label: t('stay.stats.departures'), value: String(departures.length) },
    { label: t('stay.stats.inHouse'), value: `${inHouse.length} / ${activeUnits}` },
  ];

  const pill =
    'flex min-h-9 items-center gap-1.5 rounded-full border border-linen bg-white px-3.5 py-1.5 text-xs font-semibold text-espresso/70 shadow-card transition hover:text-espresso';

  return (
    <div className="tf-rise">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">
            {t('stay.calendar.title')}
          </h1>
          <p className="mt-0.5 text-sm text-espresso/55">{monthLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href(addDays(from, -span))} className={pill} aria-label={t('common.previous')}>
            <ChevronLeft size={14} aria-hidden />
          </Link>
          <Link href={href(addDays(today, -1))} className={pill}>
            {t('common.today')}
          </Link>
          <Link href={href(addDays(from, span))} className={pill} aria-label={t('common.next')}>
            <ChevronRight size={14} aria-hidden />
          </Link>
          <div className="flex gap-1 rounded-full border border-linen bg-white p-1 text-xs shadow-card">
            {[14, 30].map((n) => (
              <Link
                key={n}
                href={href(from, n)}
                className={`rounded-full px-3 py-1.5 font-semibold transition ${
                  span === n ? 'bg-espresso text-cream' : 'text-espresso/60 hover:text-espresso'
                }`}
              >
                {t('stay.calendar.days', { n: String(n) })}
              </Link>
            ))}
          </div>
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

      {sp.error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {sp.error}
        </p>
      )}
      {sp.feeds && (
        <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">
          {t('stay.sync.done', { changes: sp.synced ?? '0', feeds: sp.feeds })}
          {Number(sp.failed) > 0 && ` ${t('stay.sync.someFailed', { n: sp.failed ?? '0' })}`}
        </p>
      )}
      {conflicts.size > 0 && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine"
        >
          <AlertTriangle size={16} aria-hidden className="mt-0.5 flex-none" />
          {t('stay.calendar.conflict')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-espresso/60">
        {(feeds ?? []).length > 0 ? (
          <form action={syncStayChannels} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="back" value={href(from)} />
            <button className={pill}>
              <RefreshCw size={13} aria-hidden />
              {t('stay.sync.now')}
            </button>
            <span>
              {lastSync
                ? t('stay.sync.last', {
                    when: new Date(lastSync).toLocaleString(LOCALE[lang], {
                      timeZone: business.timezone,
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })
                : t('stay.sync.never')}
            </span>
            {failedFeeds.length > 0 && (
              <Link href="/stays/units" className="font-semibold text-wine underline">
                {t('stay.sync.someFailed', { n: String(failedFeeds.length) })}
              </Link>
            )}
          </form>
        ) : (
          <Link href="/stays/units" className="font-semibold text-caramel hover:text-terracotta">
            {t('stay.sync.connectHint')}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {(['widget', 'manual', 'airbnb', 'booking'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-sm"
                style={{ background: SOURCE_COLORS[s].bg }}
              />
              {sourceLabel(s, t)}
            </span>
          ))}
        </div>
      </div>

      {shownUnits.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-linen bg-white px-4 py-16 text-center shadow-card">
          <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-espresso/50">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
              <CalendarPlus size={24} aria-hidden className="text-caramel" />
            </span>
            <p>{t('stay.calendar.noUnits')}</p>
            <Link
              href="/stays/units"
              className="mt-1 rounded-full bg-espresso px-5 py-2.5 text-xs font-semibold text-cream transition hover:bg-terracotta"
            >
              {t('stay.units.add')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-2xl border border-linen bg-white shadow-card">
          <div style={{ minWidth: UNIT_COL + span * DAY_MIN }}>
            <div
              className="grid border-b border-linen bg-sand/50 text-center text-[11px] font-semibold uppercase tracking-wide text-espresso/55"
              style={{ gridTemplateColumns: columns }}
            >
              <div className="sticky left-0 z-20 bg-sand px-4 py-2.5 text-left">
                {t('stay.unit')}
              </div>
              {days.map((d) => (
                <div
                  key={d.date}
                  className={`border-l border-linen/60 py-1.5 ${
                    d.today ? 'bg-caramel/25 text-espresso' : d.weekend ? 'bg-sand' : ''
                  }`}
                >
                  <span className="block">{d.weekday}</span>
                  <span className="tabular block text-sm normal-case text-espresso">{d.day}</span>
                </div>
              ))}
            </div>

            {shownUnits.map((unit) => (
              <div
                key={unit.id}
                className="relative grid border-b border-linen/60 last:border-b-0"
                style={{ gridTemplateColumns: columns, height: 46 }}
              >
                <Link
                  href={`/stays/units/${unit.id}`}
                  className="sticky left-0 z-20 flex items-center truncate border-r border-linen/60 bg-white px-4 text-sm font-medium text-espresso hover:text-terracotta"
                  title={unit.name}
                >
                  <span className={`truncate ${unit.active ? '' : 'text-espresso/40 line-through'}`}>
                    {unit.name}
                  </span>
                </Link>
                {days.map((d) => (
                  <Link
                    key={d.date}
                    href={`/stays/new?unit=${unit.id}&checkIn=${d.date}`}
                    aria-label={`${t('nav.stays.new')}: ${unit.name}, ${d.date}`}
                    className={`border-l border-linen/60 transition-colors hover:bg-caramel/15 ${
                      d.today ? 'bg-caramel/10' : d.weekend ? 'bg-sand/40' : ''
                    }`}
                  />
                ))}
                <div
                  className="pointer-events-none absolute inset-y-0 right-0 z-10"
                  style={{ left: UNIT_COL }}
                >
                  {(blocks ?? [])
                    .filter((b) => b.unit_id === unit.id)
                    .map((b) => {
                      const pos = bar(b.start_date, b.end_date);
                      if (!pos) return null;
                      return (
                        <span
                          key={b.id}
                          title={b.reason ?? t('stay.block.title')}
                          className="absolute bottom-2 top-2 truncate rounded-md px-2 text-[11px] leading-[30px] text-espresso/60"
                          style={{
                            ...pos,
                            background:
                              'repeating-linear-gradient(45deg,#ddd3be,#ddd3be 5px,#ede8dc 5px,#ede8dc 10px)',
                          }}
                        >
                          {b.reason ?? t('stay.block.title')}
                        </span>
                      );
                    })}
                  {live
                    .filter((r) => r.unit_id === unit.id)
                    .map((r) => {
                      const pos = bar(r.check_in, r.check_out);
                      if (!pos) return null;
                      const color = SOURCE_COLORS[r.source];
                      const pending = r.status === 'pending_payment';
                      const clash = conflicts.has(r.id);
                      const label = guestLabel(r, t);
                      return (
                        <Link
                          key={r.id}
                          href={`/stays/reservations/${r.id}`}
                          title={`${label} · ${r.check_in} → ${r.check_out} · ${sourceLabel(r.source, t)}`}
                          className={`pointer-events-auto absolute flex items-center gap-1 truncate rounded-md px-2 font-medium shadow-card transition hover:brightness-110 ${
                            clash ? 'text-[10px] ring-2 ring-wine' : 'bottom-1.5 top-1.5 text-xs'
                          } ${pending ? 'border border-dashed border-espresso/50' : ''}`}
                          style={{
                            ...pos,
                            ...(clash
                              ? lane.get(r.id) === 1
                                ? { top: '52%', bottom: 3 }
                                : { top: 3, bottom: '52%' }
                              : {}),
                            background: pending ? '#f1e3c8' : color.bg,
                            color: pending ? '#1a1208' : color.fg,
                          }}
                        >
                          {clash && <AlertTriangle size={10} aria-hidden className="flex-none" />}
                          <span className="truncate">{label}</span>
                        </Link>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {(
          [
            { title: t('stay.today.arrivals'), rows: arrivals, mode: 'in' },
            { title: t('stay.today.departures'), rows: departures, mode: 'out' },
          ] as const
        ).map((panel) => (
          <section key={panel.mode} className="rounded-2xl border border-linen bg-white p-5 shadow-card">
            <h2 className="font-serif text-lg font-semibold text-espresso">{panel.title}</h2>
            {panel.rows.length === 0 ? (
              <p className="mt-3 text-sm text-espresso/45">{t('stay.today.none')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-linen/60">
                {panel.rows.map((r) => {
                  const done =
                    panel.mode === 'in'
                      ? r.stay_status === 'checked_in' || r.stay_status === 'checked_out'
                      : r.stay_status === 'checked_out';
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                      <Link href={`/stays/reservations/${r.id}`} className="min-w-0 text-sm">
                        <span className="block truncate font-medium text-espresso">
                          {guestLabel(r, t)}
                        </span>
                        <span className="block truncate text-xs text-espresso/55">
                          {unitName.get(r.unit_id) ?? '—'} · {r.guests} · {sourceLabel(r.source, t)}
                        </span>
                      </Link>
                      <div className="flex items-center gap-2">
                        <form
                          action={setStayStatus.bind(
                            null,
                            r.id,
                            panel.mode === 'in' ? 'checked_in' : 'checked_out'
                          )}
                        >
                          <button
                            className={`min-h-9 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                              done
                                ? 'bg-leaf/15 text-leaf'
                                : 'bg-sand text-espresso/70 hover:bg-linen hover:text-espresso'
                            }`}
                          >
                            {panel.mode === 'in' ? t('stay.checkedIn') : t('stay.checkedOut')}
                          </button>
                        </form>
                        {panel.mode === 'in' && (
                          <form action={setStayStatus.bind(null, r.id, 'no_show')}>
                            <button
                              className={`min-h-9 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                                r.stay_status === 'no_show'
                                  ? 'bg-wine/15 text-wine'
                                  : 'bg-sand text-espresso/70 hover:bg-linen hover:text-espresso'
                              }`}
                            >
                              {t('day.noshow')}
                            </button>
                          </form>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
