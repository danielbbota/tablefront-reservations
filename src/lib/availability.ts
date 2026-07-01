import type { CapacityRule, Restaurant } from './types';

/** Minutes since midnight for "HH:MM" or "HH:MM:SS". */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD date, timezone-independent. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Current date (YYYY-MM-DD) and time (minutes since midnight) in an IANA timezone. */
export function nowInTimezone(timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/** All bookable slot times ("HH:MM") for a restaurant on a given date. */
export function slotsForDate(restaurant: Restaurant, date: string): string[] {
  const hours = restaurant.operating_hours[String(dayOfWeek(date))];
  if (!hours || hours.closed) return [];

  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  const interval = restaurant.slot_interval_minutes;
  const slots: string[] = [];
  // Last seating is at closing time minus one interval.
  for (let t = open; t + interval <= close; t += interval) {
    slots.push(toHHMM(t));
  }
  return slots;
}

/**
 * Resolve the online cover cap for one slot. Most specific rule wins:
 * date+slot > date > day-of-week+slot > day-of-week > restaurant default.
 */
export function resolveMaxCovers(
  restaurant: Restaurant,
  rules: CapacityRule[],
  date: string,
  slot: string // "HH:MM"
): number {
  const dow = dayOfWeek(date);
  const slotMin = toMinutes(slot);
  const matches = (r: CapacityRule) => {
    if (r.specific_date && r.specific_date !== date) return false;
    if (!r.specific_date && r.day_of_week !== dow) return false;
    if (r.time_slot && toMinutes(r.time_slot) !== slotMin) return false;
    return true;
  };
  const specificity = (r: CapacityRule) =>
    (r.specific_date ? 2 : 0) + (r.time_slot ? 1 : 0);

  const best = rules
    .filter(matches)
    .sort((a, b) => specificity(b) - specificity(a))[0];
  return best ? best.max_covers : restaurant.default_max_covers;
}

export type SlotAvailability = {
  time: string; // "HH:MM"
  remaining: number; // covers still bookable online (0 = full)
};

/**
 * Availability for every slot on a date. `bookedBySlot` maps "HH:MM" →
 * confirmed covers (widget + manual both count against the online cap).
 * Slots already past (restaurant-local time) are excluded for today.
 */
export function availabilityForDate(
  restaurant: Restaurant,
  rules: CapacityRule[],
  date: string,
  bookedBySlot: Map<string, number>
): SlotAvailability[] {
  const now = nowInTimezone(restaurant.timezone);
  if (date < now.date) return [];

  return slotsForDate(restaurant, date)
    .filter((time) => date !== now.date || toMinutes(time) > now.minutes)
    .map((time) => {
      const cap = resolveMaxCovers(restaurant, rules, date, time);
      const booked = bookedBySlot.get(time) ?? 0;
      return { time, remaining: Math.max(0, cap - booked) };
    });
}

/** Normalize "HH:MM:SS" (Postgres time) to "HH:MM". */
export function normalizeSlot(time: string): string {
  return time.slice(0, 5);
}
