import { dayOfWeek, toHHMM, toMinutes } from '../availability';
import type {
  Appointment,
  Restaurant,
  Service,
  Staff,
  StaffService,
  StaffTimeOff,
} from '../types';

/**
 * Slot availability for the appointments product. Pure functions, no I/O:
 * the API routes, the dashboard and the tests all feed them plain rows.
 *
 * Times are minutes since midnight in the business's own timezone; a
 * professional is busy over the half-open range [start_time, busy_until),
 * where busy_until already includes the service's clean-up buffer.
 */

const DAY_END = 24 * 60;

type BusinessHours = Pick<Restaurant, 'operating_hours' | 'slot_interval_minutes'>;
type StaffHours = Pick<Staff, 'id' | 'working_hours'>;
type ServiceTiming = Pick<Service, 'duration_minutes' | 'buffer_minutes'>;
type ApptLike = Pick<
  Appointment,
  'id' | 'staff_id' | 'date' | 'start_time' | 'busy_until' | 'status' | 'hold_expires_at'
>;
type TimeOffLike = Pick<StaffTimeOff, 'staff_id' | 'date' | 'start_time' | 'end_time'>;

/** Wall clock in the business's timezone (from nowInTimezone()). */
export type Clock = { date: string; minutes: number };

/**
 * An appointment occupies its time while it is confirmed, or while it waits
 * for payment and the hold has not run out. Mirrors create_appointment().
 */
export function isLiveAppointment(
  appt: Pick<Appointment, 'status' | 'hold_expires_at'>,
  now: Date = new Date()
): boolean {
  if (appt.status === 'confirmed') return true;
  return (
    appt.status === 'pending_payment' &&
    !!appt.hold_expires_at &&
    Date.parse(appt.hold_expires_at) > now.getTime()
  );
}

/**
 * When a professional works on a date, in minutes: their own hours when they
 * have any (a day missing from them is a day off), otherwise the business's
 * opening hours. Null = not working that day.
 */
export function workingWindow(
  business: Pick<Restaurant, 'operating_hours'>,
  staff: Pick<Staff, 'working_hours'>,
  date: string
): { open: number; close: number } | null {
  const hours = (staff.working_hours ?? business.operating_hours ?? {})[String(dayOfWeek(date))];
  if (!hours || hours.closed) return null;
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return null;
  return { open, close };
}

/** Start, end and busy-until ("HH:MM") for a service starting at `time`, or null past midnight. */
export function appointmentTimes(
  time: string,
  service: ServiceTiming
): { start: string; end: string; busyUntil: string } | null {
  const start = toMinutes(time);
  const end = start + service.duration_minutes;
  if (!Number.isFinite(start) || start < 0 || end > DAY_END) return null;
  // A buffer that would run past midnight is cut there: `time` columns end at 24:00.
  const busy = Math.min(DAY_END, end + (service.buffer_minutes ?? 0));
  return { start: toHHMM(start), end: toHHMM(end), busyUntil: toHHMM(busy) };
}

/** Is the whole day blocked for this professional? */
function dayOff(staffId: string, date: string, timeOff: TimeOffLike[]): boolean {
  return timeOff.some((o) => o.staff_id === staffId && o.date === date && !o.start_time);
}

/** The professional's busy ranges on a date: live appointments, then timed time off. */
export function busyRanges(
  staffId: string,
  date: string,
  appointments: ApptLike[],
  timeOff: TimeOffLike[],
  now: Date = new Date(),
  ignoreAppointmentId?: string
): { booked: [number, number][]; off: [number, number][] } {
  const booked = appointments
    .filter(
      (a) =>
        a.staff_id === staffId &&
        a.date === date &&
        a.id !== ignoreAppointmentId &&
        isLiveAppointment(a, now)
    )
    .map((a): [number, number] => [toMinutes(a.start_time), toMinutes(a.busy_until)]);
  const off = timeOff
    .filter((o) => o.staff_id === staffId && o.date === date && o.start_time && o.end_time)
    .map((o): [number, number] => [toMinutes(o.start_time!), toMinutes(o.end_time!)]);
  return { booked, off };
}

const overlaps = (aStart: number, aEnd: number, [bStart, bEnd]: [number, number]) =>
  aStart < bEnd && bStart < aEnd;

/**
 * Does the service at `start` (minutes) clash with nothing in the
 * professional's day? Checks live appointments and timed time off only, not
 * working hours: it backs the owner's own edits, and owners may book outside
 * opening hours on purpose.
 */
export function staffIsFree(
  staffId: string,
  date: string,
  start: number,
  service: ServiceTiming,
  appointments: ApptLike[],
  timeOff: TimeOffLike[],
  now: Date = new Date(),
  ignoreAppointmentId?: string
): boolean {
  const end = start + service.duration_minutes;
  const busyUntil = Math.min(DAY_END, end + (service.buffer_minutes ?? 0));
  const { booked, off } = busyRanges(staffId, date, appointments, timeOff, now, ignoreAppointmentId);
  if (booked.some((r) => overlaps(start, busyUntil, r))) return false;
  return !off.some((r) => overlaps(start, end, r));
}

/**
 * Bookable start times ("HH:MM") for one professional on a date.
 *
 * A start is offered when it is on the business's slot grid (counted from the
 * professional's opening time), the service itself ends by closing time, the
 * service plus its buffer clashes with no live appointment, the service
 * clashes with no time off, and, for today, it has not started yet.
 */
export function slotsForStaff(input: {
  business: BusinessHours;
  staff: StaffHours;
  service: ServiceTiming;
  date: string;
  appointments: ApptLike[];
  timeOff: TimeOffLike[];
  clock: Clock;
  now?: Date;
}): string[] {
  const { business, staff, service, date, appointments, timeOff, clock } = input;
  const now = input.now ?? new Date();
  if (date < clock.date) return [];
  if (dayOff(staff.id, date, timeOff)) return [];
  const window = workingWindow(business, staff, date);
  if (!window) return [];

  const step = Math.max(5, business.slot_interval_minutes || 30);
  const { booked, off } = busyRanges(staff.id, date, appointments, timeOff, now);
  const slots: string[] = [];
  for (let t = window.open; t + service.duration_minutes <= window.close; t += step) {
    if (date === clock.date && t <= clock.minutes) continue;
    const end = t + service.duration_minutes;
    const busyUntil = Math.min(DAY_END, end + (service.buffer_minutes ?? 0));
    if (booked.some((r) => overlaps(t, busyUntil, r))) continue;
    if (off.some((r) => overlaps(t, end, r))) continue;
    slots.push(toHHMM(t));
  }
  return slots;
}

/**
 * The active professionals who perform a service, optionally narrowed to one
 * ("any" keeps them all). An unknown or ineligible id yields an empty list.
 */
export function eligibleStaff<T extends Pick<Staff, 'id' | 'active'>>(
  serviceId: string,
  staff: T[],
  staffServices: Pick<StaffService, 'staff_id' | 'service_id'>[],
  staffId: string | 'any' = 'any'
): T[] {
  const performs = new Set(
    staffServices.filter((l) => l.service_id === serviceId).map((l) => l.staff_id)
  );
  return staff.filter(
    (s) => s.active && performs.has(s.id) && (staffId === 'any' || s.id === staffId)
  );
}

export type SlotOption = {
  time: string; // "HH:MM"
  /** Professionals free at that time. */
  staffIds: string[];
};

/**
 * Slots a guest can pick for a service on a date: one professional's slots,
 * or with "any professional" the union across everyone who performs it.
 */
export function availableSlots(input: {
  business: BusinessHours;
  service: ServiceTiming & Pick<Service, 'id'>;
  staff: (StaffHours & Pick<Staff, 'active'>)[];
  staffServices: Pick<StaffService, 'staff_id' | 'service_id'>[];
  appointments: ApptLike[];
  timeOff: TimeOffLike[];
  date: string;
  staffId?: string | 'any';
  clock: Clock;
  now?: Date;
}): SlotOption[] {
  const candidates = eligibleStaff(
    input.service.id,
    input.staff,
    input.staffServices,
    input.staffId ?? 'any'
  );
  const byTime = new Map<string, string[]>();
  for (const member of candidates) {
    for (const time of slotsForStaff({ ...input, staff: member })) {
      byTime.set(time, [...(byTime.get(time) ?? []), member.id]);
    }
  }
  return Array.from(byTime.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([time, staffIds]) => ({ time, staffIds }));
}

/**
 * Order in which to try professionals for an "any professional" booking:
 * whoever has the fewest live appointments that day first (spreads the work),
 * then the owner's own ordering, then id so the result is deterministic.
 */
export function rankStaff(
  staffIds: string[],
  staff: Pick<Staff, 'id' | 'sort'>[],
  appointments: ApptLike[],
  date: string,
  now: Date = new Date()
): string[] {
  const load = new Map<string, number>();
  for (const a of appointments) {
    if (a.date === date && isLiveAppointment(a, now)) {
      load.set(a.staff_id, (load.get(a.staff_id) ?? 0) + 1);
    }
  }
  const sortOf = new Map(staff.map((s) => [s.id, s.sort]));
  return [...staffIds].sort(
    (a, b) =>
      (load.get(a) ?? 0) - (load.get(b) ?? 0) ||
      (sortOf.get(a) ?? 0) - (sortOf.get(b) ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0)
  );
}
