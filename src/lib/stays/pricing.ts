import type { StayRate, StayUnit } from '../types';
import { daysBetween, eachNight } from './dates';

type UnitPricing = Pick<StayUnit, 'id' | 'base_price_cents' | 'cleaning_fee_cents' | 'min_nights'>;

/**
 * The seasonal rate that applies to one night, if any. When several ranges
 * cover the night the narrowest wins (a "Christmas week" inside "winter"),
 * then the one that starts latest.
 */
export function rateForNight(unitId: string, rates: StayRate[], night: string): StayRate | null {
  const span = (r: StayRate) => daysBetween(r.start_date, r.end_date);
  const covering = rates
    .filter((r) => r.unit_id === unitId && r.start_date <= night && night <= r.end_date)
    .sort((a, b) => span(a) - span(b) || (a.start_date < b.start_date ? 1 : -1));
  return covering[0] ?? null;
}

export function nightlyPrice(unit: UnitPricing, rates: StayRate[], night: string): number {
  return rateForNight(unit.id, rates, night)?.price_cents ?? unit.base_price_cents;
}

/** Minimum stay for an arrival date: the arrival night's rate can override the unit's. */
export function minNightsFor(unit: UnitPricing, rates: StayRate[], checkIn: string): number {
  return rateForNight(unit.id, rates, checkIn)?.min_nights ?? unit.min_nights;
}

export type StayQuote = {
  nights: number;
  nightly: { date: string; price_cents: number }[];
  accommodation_cents: number;
  cleaning_fee_cents: number;
  total_cents: number;
  min_nights: number;
};

export function quoteStay(
  unit: UnitPricing,
  rates: StayRate[],
  checkIn: string,
  checkOut: string
): StayQuote {
  const nightly = eachNight(checkIn, checkOut).map((date) => ({
    date,
    price_cents: nightlyPrice(unit, rates, date),
  }));
  const accommodation = nightly.reduce((sum, n) => sum + n.price_cents, 0);
  return {
    nights: nightly.length,
    nightly,
    accommodation_cents: accommodation,
    cleaning_fee_cents: unit.cleaning_fee_cents,
    total_cents: accommodation + unit.cleaning_fee_cents,
    min_nights: minNightsFor(unit, rates, checkIn),
  };
}
