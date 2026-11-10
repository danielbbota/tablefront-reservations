import type { StayBlock, StayRate, StayReservation, StayUnit } from '../types';
import { rangesOverlap } from './dates';
import { quoteStay, type StayQuote } from './pricing';

type ResLike = Pick<
  StayReservation,
  'id' | 'unit_id' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'
>;
type BlockLike = Pick<StayBlock, 'unit_id' | 'start_date' | 'end_date'>;

/**
 * A reservation occupies its dates while it is confirmed, or while it waits
 * for payment and the hold has not run out. Mirrors create_stay_reservation().
 */
export function isLive(
  res: Pick<StayReservation, 'status' | 'hold_expires_at'>,
  now: Date = new Date()
): boolean {
  if (res.status === 'confirmed') return true;
  return (
    res.status === 'pending_payment' &&
    !!res.hold_expires_at &&
    Date.parse(res.hold_expires_at) > now.getTime()
  );
}

export function unitIsFree(
  unitId: string,
  checkIn: string,
  checkOut: string,
  reservations: ResLike[],
  blocks: BlockLike[],
  now: Date = new Date(),
  ignoreReservationId?: string
): boolean {
  const taken = reservations.some(
    (r) =>
      r.unit_id === unitId &&
      r.id !== ignoreReservationId &&
      isLive(r, now) &&
      rangesOverlap(r.check_in, r.check_out, checkIn, checkOut)
  );
  if (taken) return false;
  return !blocks.some(
    (b) => b.unit_id === unitId && rangesOverlap(b.start_date, b.end_date, checkIn, checkOut)
  );
}

export type UnitOffer = { unit: StayUnit; quote: StayQuote };

/** Units a guest can book for these dates and party, cheapest first. */
export function availableUnits(
  units: StayUnit[],
  rates: StayRate[],
  reservations: ResLike[],
  blocks: BlockLike[],
  query: { checkIn: string; checkOut: string; guests: number },
  now: Date = new Date()
): UnitOffer[] {
  return units
    .filter((u) => u.active && u.max_guests >= query.guests)
    .map((unit) => ({ unit, quote: quoteStay(unit, rates, query.checkIn, query.checkOut) }))
    .filter(({ quote }) => quote.nights >= quote.min_nights)
    .filter(({ unit }) =>
      unitIsFree(unit.id, query.checkIn, query.checkOut, reservations, blocks, now)
    )
    .sort((a, b) => a.quote.total_cents - b.quote.total_cents || a.unit.sort - b.unit.sort);
}

/**
 * Reservations that share nights with another live reservation on the same
 * unit: a double booking, usually one that slipped in through a channel
 * before the calendars synced. Returns the ids of every reservation involved.
 */
export function findConflicts(reservations: ResLike[], now: Date = new Date()): Set<string> {
  const live = reservations.filter((r) => isLive(r, now));
  const byUnit = new Map<string, ResLike[]>();
  for (const r of live) byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) ?? []), r]);

  const conflicts = new Set<string>();
  for (const list of byUnit.values()) {
    list.sort((a, b) => (a.check_in < b.check_in ? -1 : a.check_in > b.check_in ? 1 : 0));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].check_in < list[i].check_out; j++) {
        conflicts.add(list[i].id);
        conflicts.add(list[j].id);
      }
    }
  }
  return conflicts;
}
