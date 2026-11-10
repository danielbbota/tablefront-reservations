import { nowInTimezone } from '../availability';
import { STAY_HORIZON_DAYS, STAY_MAX_NIGHTS, type Restaurant } from '../types';
import { addDays, daysBetween, isIsoDate } from './dates';

export type StayDatesError =
  | 'INVALID_DATES'
  | 'PAST'
  | 'TOO_FAR'
  | 'TOO_LONG';

/**
 * Validate a requested stay against the calendar, in the business's timezone:
 * real dates, departure after arrival, arrival not in the past, inside the
 * booking horizon and not longer than the maximum stay.
 */
export function checkStayDates(
  business: Pick<Restaurant, 'timezone'>,
  checkIn: unknown,
  checkOut: unknown
): { ok: true; nights: number } | { ok: false; code: StayDatesError; message: string } {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut) || checkOut <= checkIn) {
    return { ok: false, code: 'INVALID_DATES', message: 'Check-in and check-out dates are required' };
  }
  const today = nowInTimezone(business.timezone).date;
  if (checkIn < today) {
    return { ok: false, code: 'PAST', message: 'The check-in date has already passed' };
  }
  if (checkIn > addDays(today, STAY_HORIZON_DAYS)) {
    return { ok: false, code: 'TOO_FAR', message: 'Dates are beyond the booking window' };
  }
  const nights = daysBetween(checkIn, checkOut);
  if (nights > STAY_MAX_NIGHTS) {
    return { ok: false, code: 'TOO_LONG', message: `Stays are limited to ${STAY_MAX_NIGHTS} nights` };
  }
  return { ok: true, nights };
}
