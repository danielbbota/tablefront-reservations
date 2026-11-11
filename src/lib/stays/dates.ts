/** Date helpers for stays. All dates are plain YYYY-MM-DD strings (no timezone). */

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000
  );
}

/** The nights of a stay: every date in [checkIn, checkOut). */
export function eachNight(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) nights.push(d);
  return nights;
}

/** Do the half-open ranges [aStart, aEnd) and [bStart, bEnd) share a night? */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}
