'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Armchair, MapPin, Minus, Pencil, Plus, UserCheck, UserPlus, UserX, X } from 'lucide-react';
import { assignBookingTable, createWalkIn, seatWalkIn } from '@/app/floor-actions';
import { setServiceStatus } from '@/app/actions';
import { FLOOR_H, FLOOR_W, type ServiceStatus } from '@/lib/types';

export type MapZone = {
  id: string;
  name: string;
  tables: {
    id: string;
    name: string;
    seats: number;
    shape: 'rect' | 'round';
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
  }[];
  elements: {
    id: string;
    kind: 'wall' | 'bar' | 'door' | 'plant' | 'label';
    label: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
  }[];
};

export type MapBooking = {
  id: string;
  name: string;
  party: number;
  time: string; // "HH:MM"
  serviceStatus: ServiceStatus | null;
  tableIds: string[];
};

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function occupantAt(bookings: MapBooking[], tableId: string, minutes: number, turn: number) {
  return bookings.find(
    (b) =>
      b.tableIds.includes(tableId) &&
      toMin(b.time) <= minutes &&
      minutes < toMin(b.time) + turn
  );
}

/** Earliest booking on this table that starts after `minutes` — the "next up" hint. */
function nextOn(bookings: MapBooking[], tableId: string, minutes: number) {
  return bookings
    .filter((b) => b.tableIds.includes(tableId) && toMin(b.time) > minutes)
    .sort((a, b) => toMin(a.time) - toMin(b.time))[0];
}

const STATE_FILL: Record<string, { fill: string; stroke: string; text: string }> = {
  free: { fill: '#ffffff', stroke: '#b8ab8d', text: '#1a1208' },
  reserved: { fill: '#fdf6ec', stroke: '#c9954a', text: '#1a1208' },
  arrived: { fill: '#c9954a', stroke: '#c9954a', text: '#1a1208' },
  seated: { fill: '#4a7c4e', stroke: '#4a7c4e', text: '#ffffff' },
  no_show: { fill: '#7c3a3a', stroke: '#7c3a3a', text: '#ffffff' },
};

const STATUS_ICON = { arrived: UserCheck, seated: Armchair, no_show: UserX } as const;
const STATUS_ON: Record<ServiceStatus, string> = {
  arrived: 'border-caramel bg-caramel text-espresso',
  seated: 'border-leaf bg-leaf text-cream',
  no_show: 'border-wine bg-wine text-cream',
};

export default function FloorMap({
  zones,
  bookings,
  slots,
  turn,
  date,
  initialMinutes,
  labels,
}: {
  zones: MapZone[];
  bookings: MapBooking[];
  slots: string[];
  turn: number;
  date: string;
  initialMinutes: number;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Optimistic copy of the bookings — every action updates this immediately
  // so the UI never waits on the network; the server round-trip and
  // router.refresh() reconcile in the background.
  const [items, setItems] = useState(bookings);
  useEffect(() => setItems(bookings), [bookings]);

  const [zi, setZi] = useState(0);
  const [selTable, setSelTable] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ bookingId: string; tableId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walkinParty, setWalkinParty] = useState(2);
  const [tableWalkinParty, setTableWalkinParty] = useState(2);
  const [walkinBusy, setWalkinBusy] = useState(false);

  const slotIndex = useMemo(() => {
    if (!slots.length) return 0;
    let best = 0;
    slots.forEach((s, i) => {
      if (toMin(s) <= initialMinutes) best = i;
    });
    return best;
  }, [slots, initialMinutes]);
  const [ti, setTi] = useState(slotIndex);
  const timeMin = slots.length ? toMin(slots[Math.min(ti, slots.length - 1)]) : initialMinutes;
  const timeLabel = slots.length ? slots[Math.min(ti, slots.length - 1)] : '—';

  const zone = zones[Math.min(zi, zones.length - 1)];
  const allTables = useMemo(() => zones.flatMap((z) => z.tables), [zones]);
  const tableName = (id: string) => allTables.find((t) => t.id === id)?.name;

  const bySlot = useMemo(() => {
    const m = new Map<string, MapBooking[]>();
    for (const b of [...items].sort((a, b2) => toMin(a.time) - toMin(b2.time))) {
      if (!m.has(b.time)) m.set(b.time, []);
      m.get(b.time)!.push(b);
    }
    return m;
  }, [items]);

  const assigningBooking = items.find((b) => b.id === assigning) ?? null;

  const refresh = () => startTransition(() => router.refresh());

  /** Optimistic service-status toggle shared by list rows and table panel. */
  const toggleStatus = (b: MapBooking, st: ServiceStatus) => {
    const next = b.serviceStatus === st ? null : st;
    setItems((cur) => cur.map((x) => (x.id === b.id ? { ...x, serviceStatus: next } : x)));
    startTransition(async () => {
      try {
        await setServiceStatus(b.id, st, date);
      } finally {
        router.refresh();
      }
    });
  };

  const doAssign = (bookingId: string, tableId: string, force = false) =>
    startTransition(async () => {
      setError(null);
      const res = await assignBookingTable(bookingId, tableId, force);
      if (res.conflict) {
        setConflict({ bookingId, tableId });
        return;
      }
      if (res.error) setError(res.error);
      else
        setItems((cur) =>
          cur.map((x) => (x.id === bookingId ? { ...x, tableIds: [tableId] } : x))
        );
      setConflict(null);
      setAssigning(null);
      router.refresh();
    });

  const doUnassign = (bookingId: string) => {
    setItems((cur) => cur.map((x) => (x.id === bookingId ? { ...x, tableIds: [] } : x)));
    startTransition(async () => {
      await assignBookingTable(bookingId, null);
      router.refresh();
    });
  };

  const doWalkIn = (tableId: string | null, party: number) => {
    setWalkinBusy(true);
    startTransition(async () => {
      const res = tableId
        ? await seatWalkIn(tableId, date, timeLabel, party, labels.walkinName)
        : await createWalkIn(date, timeLabel, party, labels.walkinName);
      if (res.error) setError(res.error);
      setWalkinBusy(false);
      router.refresh();
    });
  };

  const tapTable = (tableId: string) => {
    if (assigning) {
      doAssign(assigning, tableId);
      return;
    }
    setSelTable((cur) => (cur === tableId ? null : tableId));
    setTableWalkinParty(2);
  };

  /** Clicking a list row: locate its table, or start assigning if it has none. */
  const tapRow = (b: MapBooking) => {
    if (b.tableIds.length) {
      const tid = b.tableIds[0];
      const zIdx = zones.findIndex((z) => z.tables.some((t) => t.id === tid));
      if (zIdx >= 0) setZi(zIdx);
      setSelTable(tid);
      const si = slots.indexOf(b.time);
      if (si >= 0) setTi(si);
      setAssigning(null);
    } else {
      setAssigning((cur) => (cur === b.id ? null : b.id));
      setConflict(null);
      setSelTable(null);
    }
  };

  const selected = selTable ? allTables.find((t) => t.id === selTable) : null;
  const selectedBookings = selected
    ? items
        .filter((b) => b.tableIds.includes(selected.id))
        .sort((a, b) => toMin(a.time) - toMin(b.time))
    : [];
  const selectedOccupant = selected ? occupantAt(items, selected.id, timeMin, turn) : null;

  const legend = [
    ['free', labels.free],
    ['reserved', labels.reserved],
    ['arrived', labels.arrived],
    ['seated', labels.seated],
    ['no_show', labels.noshow],
  ] as const;

  const statusBtns = (b: MapBooking, big = false) => (
    <span className="flex gap-1">
      {(['arrived', 'seated', 'no_show'] as ServiceStatus[]).map((st) => {
        const Icon = STATUS_ICON[st];
        const on = b.serviceStatus === st;
        const label = st === 'arrived' ? labels.arrived : st === 'seated' ? labels.seated : labels.noshow;
        return (
          <button
            key={st}
            onClick={(e) => {
              e.stopPropagation();
              toggleStatus(b, st);
            }}
            aria-pressed={on}
            aria-label={label}
            title={label}
            className={`flex items-center justify-center rounded-full border transition active:scale-90 ${
              big ? 'h-9 w-9' : 'h-8 w-8'
            } ${
              on ? STATUS_ON[st] : 'border-linen text-espresso/40 hover:border-caramel hover:text-espresso'
            }`}
          >
            <Icon size={big ? 15 : 13} aria-hidden />
          </button>
        );
      })}
    </span>
  );

  return (
    <div className="mt-6">
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_1fr]">
        {/* ── left: bookings list + walk-in ─────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl border border-linen bg-white p-4 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-espresso/50">
                {labels.walkin}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  aria-label="-"
                  onClick={() => setWalkinParty((p) => Math.max(1, p - 1))}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                >
                  <Minus size={14} aria-hidden />
                </button>
                <span className="tabular w-7 text-center text-sm font-semibold text-espresso">
                  {walkinParty}
                </span>
                <button
                  aria-label="+"
                  onClick={() => setWalkinParty((p) => Math.min(30, p + 1))}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                >
                  <Plus size={14} aria-hidden />
                </button>
                <button
                  onClick={() => doWalkIn(null, walkinParty)}
                  disabled={!slots.length || walkinBusy}
                  className="ml-1 flex min-h-9 items-center gap-1.5 rounded-lg bg-leaf px-3.5 py-2 text-xs font-semibold text-cream transition hover:opacity-90 active:scale-95 disabled:opacity-50"
                >
                  <UserPlus size={14} aria-hidden />
                  {timeLabel}
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-linen bg-white shadow-card">
            {items.length === 0 && (
              <p className="p-6 text-center text-sm text-espresso/40">{labels.empty}</p>
            )}
            {Array.from(bySlot.entries()).map(([slot, slotBookings]) => (
              <div key={slot}>
                <div className="flex items-baseline justify-between border-b border-linen bg-sand/50 px-4 py-2">
                  <span className="tabular font-serif text-sm font-semibold text-espresso">
                    {slot}
                  </span>
                  <span className="tabular text-[11px] text-espresso/50">
                    {slotBookings.reduce((s, b) => s + b.party, 0)} {labels.covers}
                  </span>
                </div>
                <ul className="divide-y divide-linen/50">
                  {slotBookings.map((b) => {
                    const isAssigning = assigning === b.id;
                    return (
                      <li
                        key={b.id}
                        onClick={() => tapRow(b)}
                        className={`flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors ${
                          isAssigning ? 'bg-caramel/15' : 'hover:bg-sand/30'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-espresso">
                            {b.name}
                            <span className="tabular ml-1.5 text-espresso/50">× {b.party}</span>
                          </p>
                          {b.tableIds.length > 0 ? (
                            <span className="mt-0.5 inline-block rounded bg-sand px-1.5 py-0.5 text-[10px] font-semibold text-espresso/60">
                              {labels.table} {b.tableIds.map(tableName).filter(Boolean).join('+')}
                            </span>
                          ) : (
                            <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-terracotta">
                              <MapPin size={10} aria-hidden />
                              {labels.assign}
                            </span>
                          )}
                        </div>
                        {statusBtns(b)}
                        <Link
                          href={`/bookings/${b.id}/edit`}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={labels.edit}
                          className="flex h-8 w-8 items-center justify-center rounded-full text-espresso/35 transition hover:bg-sand hover:text-terracotta"
                        >
                          <Pencil size={13} aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* ── right: map ────────────────────────────────────────────────── */}
        <div>
          {zones.length === 0 ? (
            <div className="rounded-2xl border border-linen bg-white p-12 text-center text-espresso/50 shadow-card">
              {labels.noTables}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  {zones.map((z, i) => (
                    <button
                      key={z.id}
                      onClick={() => {
                        setZi(i);
                        setSelTable(null);
                      }}
                      className={`min-h-9 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                        i === zi
                          ? 'bg-espresso text-cream shadow-card'
                          : 'border border-linen bg-white text-espresso/60 hover:text-espresso'
                      }`}
                    >
                      {z.name}
                    </button>
                  ))}
                </div>
                {slots.length > 0 && (
                  <div className="flex min-w-56 flex-1 items-center gap-3 sm:max-w-xs">
                    <input
                      type="range"
                      min={0}
                      max={slots.length - 1}
                      value={Math.min(ti, slots.length - 1)}
                      onChange={(e) => setTi(Number(e.target.value))}
                      aria-label={timeLabel}
                      className="w-full accent-terracotta"
                    />
                    <span className="tabular rounded-lg bg-espresso px-3 py-1.5 font-serif text-sm font-semibold text-cream">
                      {timeLabel}
                    </span>
                  </div>
                )}
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-espresso/60">
                {legend.map(([key, label]) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-3 w-3 rounded-full border-2"
                      style={{
                        background: STATE_FILL[key].fill,
                        borderColor: STATE_FILL[key].stroke,
                      }}
                    />
                    {label}
                  </span>
                ))}
              </div>

              {assigningBooking && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-caramel bg-caramel/10 px-4 py-3 text-sm text-espresso">
                  <span className="font-semibold">
                    {assigningBooking.time} · {assigningBooking.name} × {assigningBooking.party}
                  </span>
                  {conflict ? (
                    <>
                      <span className="text-wine">{labels.conflict}</span>
                      <button
                        onClick={() => doAssign(conflict.bookingId, conflict.tableId, true)}
                        className="rounded-full bg-wine px-3.5 py-1.5 text-xs font-semibold text-cream transition hover:opacity-90"
                      >
                        {labels.assignAnyway}
                      </button>
                    </>
                  ) : (
                    <span className="text-espresso/60">{labels.assignHint}</span>
                  )}
                  <button
                    onClick={() => {
                      setAssigning(null);
                      setConflict(null);
                    }}
                    aria-label={labels.cancel}
                    className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-espresso/50 transition hover:bg-sand"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </div>
              )}

              <div className="mt-3 overflow-x-auto rounded-2xl border border-linen bg-white p-3 shadow-card">
                <svg
                  viewBox={`0 0 ${FLOOR_W} ${FLOOR_H}`}
                  className="h-auto w-full min-w-140 touch-none select-none rounded-xl"
                >
                  <rect width={FLOOR_W} height={FLOOR_H} fill="#faf7ee" />

                  {zone.elements.map((el) => (
                    <g
                      key={el.id}
                      transform={`translate(${el.x} ${el.y}) rotate(${el.rotation} ${el.w / 2} ${el.h / 2})`}
                    >
                      {el.kind === 'wall' && <rect width={el.w} height={el.h} rx={3} fill="#d6cbb2" />}
                      {el.kind === 'bar' && (
                        <>
                          <rect width={el.w} height={el.h} rx={10} fill="#ede8dc" stroke="#c9954a" strokeWidth={2} />
                          <text x={el.w / 2} y={el.h / 2 + 4} textAnchor="middle" fontSize={14} fill="#6b5f4b" fontWeight={600}>
                            {el.label ?? ''}
                          </text>
                        </>
                      )}
                      {el.kind === 'door' && <rect width={el.w} height={el.h} rx={4} fill="#c9954a" />}
                      {el.kind === 'plant' && (
                        <>
                          <circle cx={el.w / 2} cy={el.h / 2} r={Math.min(el.w, el.h) / 2} fill="#4a7c4e" opacity={0.25} />
                          <circle cx={el.w / 2} cy={el.h / 2} r={Math.min(el.w, el.h) / 4} fill="#4a7c4e" opacity={0.6} />
                        </>
                      )}
                      {el.kind === 'label' && (
                        <text x={el.w / 2} y={el.h / 2 + 5} textAnchor="middle" fontSize={16} fill="#8a7f6a" fontWeight={600} letterSpacing={1}>
                          {el.label ?? ''}
                        </text>
                      )}
                    </g>
                  ))}

                  {zone.tables.map((t) => {
                    const occ = occupantAt(items, t.id, timeMin, turn);
                    const next = occ ? undefined : nextOn(items, t.id, timeMin);
                    const state = occ ? occ.serviceStatus ?? 'reserved' : 'free';
                    const s = STATE_FILL[state];
                    const isSel = selTable === t.id;
                    const highlight = assigning && !occ;
                    return (
                      <g
                        key={t.id}
                        transform={`translate(${t.x} ${t.y}) rotate(${t.rotation} ${t.w / 2} ${t.h / 2})`}
                        onClick={() => tapTable(t.id)}
                        className="cursor-pointer"
                        role="button"
                        aria-label={`${t.name}${occ ? ` — ${occ.name}` : ''}`}
                      >
                        {t.shape === 'round' ? (
                          <ellipse
                            cx={t.w / 2}
                            cy={t.h / 2}
                            rx={t.w / 2}
                            ry={t.h / 2}
                            fill={s.fill}
                            stroke={isSel ? '#8c4225' : highlight ? '#c9954a' : s.stroke}
                            strokeWidth={isSel || highlight ? 4 : state === 'reserved' ? 3 : 2}
                            strokeDasharray={highlight ? '8 5' : undefined}
                          />
                        ) : (
                          <rect
                            width={t.w}
                            height={t.h}
                            rx={12}
                            fill={s.fill}
                            stroke={isSel ? '#8c4225' : highlight ? '#c9954a' : s.stroke}
                            strokeWidth={isSel || highlight ? 4 : state === 'reserved' ? 3 : 2}
                            strokeDasharray={highlight ? '8 5' : undefined}
                          />
                        )}
                        <text
                          x={t.w / 2}
                          y={occ || next ? t.h / 2 - 8 : t.h / 2 - 1}
                          textAnchor="middle"
                          fontSize={16}
                          fontWeight={700}
                          fill={s.text}
                        >
                          {t.name}
                        </text>
                        {occ ? (
                          <>
                            <text x={t.w / 2} y={t.h / 2 + 8} textAnchor="middle" fontSize={11} fill={s.text} opacity={0.9}>
                              {occ.name.split(' ')[0]} ×{occ.party}
                            </text>
                            <text x={t.w / 2} y={t.h / 2 + 21} textAnchor="middle" fontSize={10} fill={s.text} opacity={0.7}>
                              {occ.time}
                            </text>
                          </>
                        ) : next ? (
                          <>
                            <text x={t.w / 2} y={t.h / 2 + 8} textAnchor="middle" fontSize={9.5} fill="#8c4225" fontWeight={600}>
                              {next.time} {next.name.split(' ')[0]}
                            </text>
                            <text x={t.w / 2} y={t.h / 2 + 20} textAnchor="middle" fontSize={9} fill="#8a7f6a">
                              ×{next.party} · ⛁ {t.seats}
                            </text>
                          </>
                        ) : (
                          <text x={t.w / 2} y={t.h / 2 + 14} textAnchor="middle" fontSize={10} fill="#8a7f6a">
                            ⛁ {t.seats}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {selected && (
                <div className="tf-rise mt-4 rounded-2xl border border-linen bg-white p-5 shadow-card">
                  <div className="flex items-center justify-between">
                    <h2 className="font-serif text-lg font-semibold text-espresso">
                      {labels.table} {selected.name}
                      <span className="ml-2 font-sans text-sm font-normal text-espresso/50">
                        ⛁ {selected.seats}
                      </span>
                    </h2>
                    <button
                      onClick={() => setSelTable(null)}
                      aria-label={labels.cancel}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-espresso/50 transition hover:bg-sand"
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </div>

                  {selectedBookings.length > 0 && (
                    <ul className="mt-3 divide-y divide-linen/60">
                      {selectedBookings.map((b) => (
                        <li key={b.id} className="flex flex-wrap items-center gap-3 py-2.5">
                          <span className="tabular font-semibold text-espresso">{b.time}</span>
                          <span className="text-sm text-espresso">
                            {b.name} × {b.party}
                          </span>
                          {b.id === selectedOccupant?.id && statusBtns(b, true)}
                          <button
                            onClick={() => doUnassign(b.id)}
                            className="ml-auto text-xs font-semibold text-wine/80 transition hover:text-wine"
                          >
                            {labels.unassign}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {!selectedOccupant && (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          aria-label="-"
                          onClick={() => setTableWalkinParty((p) => Math.max(1, p - 1))}
                          className="flex h-10 w-10 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                        >
                          <Minus size={15} aria-hidden />
                        </button>
                        <span className="tabular w-8 text-center font-semibold text-espresso">
                          {tableWalkinParty}
                        </span>
                        <button
                          aria-label="+"
                          onClick={() => setTableWalkinParty((p) => Math.min(30, p + 1))}
                          className="flex h-10 w-10 items-center justify-center rounded-lg border border-linen text-espresso/60 hover:border-caramel"
                        >
                          <Plus size={15} aria-hidden />
                        </button>
                      </div>
                      <button
                        onClick={() => doWalkIn(selected.id, tableWalkinParty)}
                        disabled={!slots.length || walkinBusy}
                        className="flex min-h-11 items-center gap-2 rounded-lg bg-leaf px-5 py-2.5 text-sm font-semibold text-cream transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
                      >
                        <UserPlus size={15} aria-hidden />
                        {labels.walkin}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
