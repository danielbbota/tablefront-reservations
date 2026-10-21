import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availabilityForDate,
  dayOfWeek,
  normalizeSlot,
  nowInTimezone,
  resolveMaxCovers,
  slotsForDate,
  toHHMM,
  toMinutes,
} from '@/lib/availability';
import type { CapacityRule, Restaurant } from '@/lib/types';

const restaurant: Restaurant = {
  id: 'r1',
  name: 'Test',
  slug: 'test',
  timezone: 'UTC',
  slot_interval_minutes: 30,
  operating_hours: {
    '0': { open: '12:00', close: '14:00', closed: true }, // Sunday closed
    '1': { open: '18:00', close: '22:00', closed: false },
    '2': { open: '18:00', close: '22:00', closed: false },
    '3': { open: '18:00', close: '22:00', closed: false },
    '4': { open: '18:00', close: '22:00', closed: false },
    '5': { open: '18:00', close: '23:00', closed: false },
    '6': { open: '12:00', close: '13:15', closed: false },
  },
  default_max_covers: 20,
  language: 'en',
  turn_time_minutes: 90,
  brand: {},
  created_at: '2026-01-01T00:00:00Z',
};

const rule = (partial: Partial<CapacityRule>): CapacityRule => ({
  id: 'x',
  restaurant_id: 'r1',
  day_of_week: null,
  specific_date: null,
  time_slot: null,
  max_covers: 0,
  ...partial,
});

afterEach(() => vi.useRealTimers());

describe('time helpers', () => {
  it('toMinutes parses HH:MM and HH:MM:SS', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('18:30')).toBe(18 * 60 + 30);
    expect(toMinutes('23:59:59')).toBe(23 * 60 + 59);
  });
  it('toHHMM zero-pads and round-trips', () => {
    expect(toHHMM(0)).toBe('00:00');
    expect(toHHMM(9 * 60 + 5)).toBe('09:05');
    expect(toHHMM(toMinutes('21:45'))).toBe('21:45');
  });
  it('normalizeSlot trims Postgres seconds', () => {
    expect(normalizeSlot('19:00:00')).toBe('19:00');
    expect(normalizeSlot('19:00')).toBe('19:00');
  });
  it('dayOfWeek is timezone independent (0 = Sunday)', () => {
    expect(dayOfWeek('2026-10-18')).toBe(0); // Sunday
    expect(dayOfWeek('2026-10-19')).toBe(1); // Monday
    expect(dayOfWeek('2026-10-24')).toBe(6); // Saturday
    expect(dayOfWeek('2024-02-29')).toBe(4); // leap day, Thursday
  });
});

describe('nowInTimezone', () => {
  it('returns the local date and minutes for the given IANA zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T23:30:00Z'));
    expect(nowInTimezone('UTC')).toEqual({ date: '2026-10-21', minutes: 23 * 60 + 30 });
    // Tokyo is UTC+9: already the next day, 08:30.
    expect(nowInTimezone('Asia/Tokyo')).toEqual({ date: '2026-10-22', minutes: 8 * 60 + 30 });
    // Lisbon is UTC+1 in October (WEST): 00:30 next day.
    expect(nowInTimezone('Europe/Lisbon')).toEqual({ date: '2026-10-22', minutes: 30 });
  });
  it('never yields 24:xx at midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    expect(nowInTimezone('UTC')).toEqual({ date: '2026-10-21', minutes: 0 });
  });
});

describe('slotsForDate', () => {
  it('returns no slots on a closed day', () => {
    expect(slotsForDate(restaurant, '2026-10-18')).toEqual([]); // Sunday
  });
  it('returns no slots when the day has no hours configured', () => {
    const r = { ...restaurant, operating_hours: {} };
    expect(slotsForDate(r, '2026-10-19')).toEqual([]);
  });
  it('steps by the slot interval and stops one interval before closing', () => {
    expect(slotsForDate(restaurant, '2026-10-19')).toEqual([
      '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30',
    ]);
  });
  it('drops a trailing partial interval', () => {
    // Saturday 12:00–13:15 with 30 min slots: 12:00, 12:30 fit; 13:00 would end 13:30 > close.
    expect(slotsForDate(restaurant, '2026-10-24')).toEqual(['12:00', '12:30']);
  });
  it('honours a different interval', () => {
    const r = { ...restaurant, slot_interval_minutes: 60 };
    expect(slotsForDate(r, '2026-10-23')).toEqual(['18:00', '19:00', '20:00', '21:00', '22:00']); // Friday until 23:00
  });
});

describe('resolveMaxCovers', () => {
  const monday = '2026-10-19';
  it('falls back to the restaurant default without rules', () => {
    expect(resolveMaxCovers(restaurant, [], monday, '19:00')).toBe(20);
  });
  it('ignores rules for other days, dates and slots', () => {
    const rules = [
      rule({ day_of_week: 2, max_covers: 1 }),
      rule({ specific_date: '2026-10-20', max_covers: 2 }),
      rule({ day_of_week: 1, time_slot: '20:00:00', max_covers: 3 }),
    ];
    expect(resolveMaxCovers(restaurant, rules, monday, '19:00')).toBe(20);
  });
  it('applies a day-of-week rule', () => {
    expect(resolveMaxCovers(restaurant, [rule({ day_of_week: 1, max_covers: 30 })], monday, '19:00')).toBe(30);
  });
  it('most specific rule wins: date+slot > date > dow+slot > dow', () => {
    const rules = [
      rule({ day_of_week: 1, max_covers: 10 }),
      rule({ day_of_week: 1, time_slot: '19:00:00', max_covers: 11 }),
      rule({ specific_date: monday, max_covers: 12 }),
      rule({ specific_date: monday, time_slot: '19:00', max_covers: 13 }),
    ];
    expect(resolveMaxCovers(restaurant, rules, monday, '19:00')).toBe(13);
    expect(resolveMaxCovers(restaurant, rules.slice(0, 3), monday, '19:00')).toBe(12);
    expect(resolveMaxCovers(restaurant, rules.slice(0, 2), monday, '19:00')).toBe(11);
    expect(resolveMaxCovers(restaurant, rules.slice(0, 1), monday, '19:00')).toBe(10);
    // A different slot on the same date skips the slot-specific rules.
    expect(resolveMaxCovers(restaurant, rules, monday, '20:00')).toBe(12);
  });
  it('matches time slots regardless of seconds formatting', () => {
    expect(resolveMaxCovers(restaurant, [rule({ day_of_week: 1, time_slot: '19:00:00', max_covers: 7 })], monday, '19:00')).toBe(7);
  });
});

describe('availabilityForDate', () => {
  it('returns nothing for a past date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    expect(availabilityForDate(restaurant, [], '2026-10-20', new Map())).toEqual([]);
  });
  it('excludes slots already past for today, in the restaurant timezone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T19:00:00Z')); // Monday 19:00 UTC
    const times = availabilityForDate(restaurant, [], '2026-10-19', new Map()).map((s) => s.time);
    expect(times).toEqual(['19:30', '20:00', '20:30', '21:00', '21:30']); // 19:00 itself is not strictly after now
    // Same instant seen from Lisbon (UTC+1): it is 20:00 there.
    const lisbon = { ...restaurant, timezone: 'Europe/Lisbon' };
    expect(availabilityForDate(lisbon, [], '2026-10-19', new Map()).map((s) => s.time)).toEqual(['20:30', '21:00', '21:30']);
  });
  it('subtracts booked covers and floors at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    const booked = new Map([
      ['18:00', 5],
      ['18:30', 25], // over-booked (manual bookings bypass the cap)
    ]);
    const rules = [rule({ day_of_week: 1, time_slot: '19:00', max_covers: 4 })];
    const result = availabilityForDate(restaurant, rules, '2026-10-19', booked);
    expect(result.find((s) => s.time === '18:00')?.remaining).toBe(15);
    expect(result.find((s) => s.time === '18:30')?.remaining).toBe(0);
    expect(result.find((s) => s.time === '19:00')?.remaining).toBe(4);
    expect(result.find((s) => s.time === '21:30')?.remaining).toBe(20);
    expect(result).toHaveLength(8);
  });
  it('returns nothing on a closed day even in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    expect(availabilityForDate(restaurant, [], '2026-10-18', new Map())).toEqual([]);
  });
});
