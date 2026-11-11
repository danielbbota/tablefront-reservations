// Pure stays logic: nightly pricing with seasonal rates, which units are free,
// and double-booking detection.
import { describe, expect, it } from 'vitest';
import { availableUnits, findConflicts, isLive, unitIsFree } from '@/lib/stays/availability';
import { addDays, daysBetween, eachNight, isIsoDate, rangesOverlap } from '@/lib/stays/dates';
import { minNightsFor, nightlyPrice, quoteStay, rateForNight } from '@/lib/stays/pricing';
import type { StayRate, StayReservation, StayUnit } from '@/lib/types';

const unit = (over: Partial<StayUnit> = {}): StayUnit => ({
  id: 'u1',
  restaurant_id: 'r1',
  name: 'Sea room',
  description: null,
  max_guests: 2,
  base_price_cents: 8000,
  cleaning_fee_cents: 2500,
  min_nights: 1,
  sort: 0,
  active: true,
  ical_token: 't',
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const rate = (over: Partial<StayRate>): StayRate => ({
  id: 'x',
  restaurant_id: 'r1',
  unit_id: 'u1',
  start_date: '2030-07-01',
  end_date: '2030-08-31',
  price_cents: 12000,
  min_nights: null,
  ...over,
});

type Res = Pick<StayReservation, 'id' | 'unit_id' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'>;
const res = (id: string, checkIn: string, checkOut: string, over: Partial<Res> = {}): Res => ({
  id,
  unit_id: 'u1',
  check_in: checkIn,
  check_out: checkOut,
  status: 'confirmed',
  hold_expires_at: null,
  ...over,
});

const NOW = new Date('2030-01-01T12:00:00Z');

describe('date helpers', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2030-02-28')).toBe(true);
    expect(isIsoDate('2030-02-30')).toBe(false);
    expect(isIsoDate('2030-2-3')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
  it('adds days across months and years', () => {
    expect(addDays('2030-01-31', 1)).toBe('2030-02-01');
    expect(addDays('2030-12-31', 1)).toBe('2031-01-01');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
  });
  it('counts nights, not calendar days touched', () => {
    expect(daysBetween('2030-03-01', '2030-03-04')).toBe(3);
    expect(eachNight('2030-03-01', '2030-03-04')).toEqual(['2030-03-01', '2030-03-02', '2030-03-03']);
  });
  it('a stay ending the day another begins does not overlap it', () => {
    expect(rangesOverlap('2030-03-01', '2030-03-04', '2030-03-04', '2030-03-06')).toBe(false);
    expect(rangesOverlap('2030-03-01', '2030-03-04', '2030-03-03', '2030-03-06')).toBe(true);
  });
});

describe('pricing', () => {
  it('charges the base price outside any season', () => {
    expect(nightlyPrice(unit(), [rate({})], '2030-06-30')).toBe(8000);
    expect(nightlyPrice(unit(), [rate({})], '2030-09-01')).toBe(8000);
  });
  it('season dates are inclusive on both ends', () => {
    expect(nightlyPrice(unit(), [rate({})], '2030-07-01')).toBe(12000);
    expect(nightlyPrice(unit(), [rate({})], '2030-08-31')).toBe(12000);
  });
  it('the narrowest season wins when several cover a night', () => {
    const rates = [
      rate({ id: 'summer' }),
      rate({ id: 'festival', start_date: '2030-08-10', end_date: '2030-08-12', price_cents: 20000 }),
    ];
    expect(rateForNight('u1', rates, '2030-08-11')?.id).toBe('festival');
    expect(rateForNight('u1', rates, '2030-08-13')?.id).toBe('summer');
  });
  it('ignores another unit’s seasons', () => {
    expect(nightlyPrice(unit(), [rate({ unit_id: 'other' })], '2030-07-15')).toBe(8000);
  });
  it('quotes a stay that crosses into a season, plus the cleaning fee once', () => {
    const quote = quoteStay(unit(), [rate({})], '2030-06-29', '2030-07-02');
    expect(quote.nightly.map((n) => n.price_cents)).toEqual([8000, 8000, 12000]);
    expect(quote).toMatchObject({
      nights: 3,
      accommodation_cents: 28000,
      cleaning_fee_cents: 2500,
      total_cents: 30500,
    });
  });
  it('the arrival night’s season can raise the minimum stay', () => {
    const u = unit({ min_nights: 2 });
    expect(minNightsFor(u, [rate({ min_nights: 5 })], '2030-07-10')).toBe(5);
    expect(minNightsFor(u, [rate({ min_nights: null })], '2030-07-10')).toBe(2);
    expect(minNightsFor(u, [rate({ min_nights: 5 })], '2030-06-10')).toBe(2);
  });
});

describe('availability', () => {
  it('a hold counts while it has time left, and stops counting after', () => {
    expect(isLive({ status: 'confirmed', hold_expires_at: null }, NOW)).toBe(true);
    expect(isLive({ status: 'cancelled', hold_expires_at: null }, NOW)).toBe(false);
    expect(isLive({ status: 'pending_payment', hold_expires_at: '2030-01-01T12:10:00Z' }, NOW)).toBe(true);
    expect(isLive({ status: 'pending_payment', hold_expires_at: '2030-01-01T11:59:00Z' }, NOW)).toBe(false);
    expect(isLive({ status: 'pending_payment', hold_expires_at: null }, NOW)).toBe(false);
  });

  it('a unit is free around, but not across, an existing stay or block', () => {
    const taken = [res('a', '2030-03-01', '2030-03-04')];
    const blocks = [{ unit_id: 'u1', start_date: '2030-03-10', end_date: '2030-03-12' }];
    expect(unitIsFree('u1', '2030-03-04', '2030-03-06', taken, blocks, NOW)).toBe(true);
    expect(unitIsFree('u1', '2030-03-03', '2030-03-06', taken, blocks, NOW)).toBe(false);
    expect(unitIsFree('u1', '2030-03-11', '2030-03-13', taken, blocks, NOW)).toBe(false);
    expect(unitIsFree('u2', '2030-03-01', '2030-03-04', taken, blocks, NOW)).toBe(true);
    // Editing a reservation must not collide with itself.
    expect(unitIsFree('u1', '2030-03-02', '2030-03-05', taken, [], NOW, 'a')).toBe(true);
  });

  it('offers only active units that fit the party, the dates and the minimum stay, cheapest first', () => {
    const units = [
      unit({ id: 'u1', name: 'Double', base_price_cents: 9000 }),
      unit({ id: 'u2', name: 'Family', max_guests: 4, base_price_cents: 14000, sort: 1 }),
      unit({ id: 'u3', name: 'Closed', active: false }),
      unit({ id: 'u4', name: 'Week only', min_nights: 7, base_price_cents: 5000, sort: 2 }),
      unit({ id: 'u5', name: 'Budget', base_price_cents: 6000, sort: 3 }),
    ];
    const taken = [res('a', '2030-03-02', '2030-03-03', { unit_id: 'u5' })];
    const stay = { checkIn: '2030-03-01', checkOut: '2030-03-03' };

    expect(availableUnits(units, [], taken, [], { ...stay, guests: 2 }, NOW).map((o) => o.unit.name)).toEqual([
      'Double',
      'Family',
    ]);
    expect(availableUnits(units, [], taken, [], { ...stay, guests: 3 }, NOW).map((o) => o.unit.name)).toEqual([
      'Family',
    ]);
    expect(availableUnits(units, [], taken, [], { ...stay, guests: 5 }, NOW)).toEqual([]);
  });

  it('flags every reservation involved in a double booking, per unit', () => {
    const list = [
      res('direct', '2030-03-01', '2030-03-05'),
      res('airbnb', '2030-03-04', '2030-03-08'),
      res('later', '2030-03-08', '2030-03-10'),
      res('other-unit', '2030-03-01', '2030-03-05', { unit_id: 'u2' }),
      res('cancelled', '2030-03-01', '2030-03-05', { status: 'cancelled' }),
      res('expired-hold', '2030-03-01', '2030-03-05', {
        status: 'pending_payment',
        hold_expires_at: '2029-12-31T00:00:00Z',
      }),
    ];
    expect([...findConflicts(list, NOW)].sort()).toEqual(['airbnb', 'direct']);
    expect(findConflicts([res('a', '2030-03-01', '2030-03-04'), res('b', '2030-03-04', '2030-03-06')], NOW).size).toBe(0);
  });
});
