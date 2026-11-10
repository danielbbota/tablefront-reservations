// Slot availability for the appointments product: pure logic, no network.
import { describe, expect, it } from 'vitest';
import {
  appointmentTimes,
  availableSlots,
  eligibleStaff,
  isLiveAppointment,
  rankStaff,
  slotsForStaff,
  staffIsFree,
  workingWindow,
  type Clock,
} from '@/lib/appointments/slots';
import type { Appointment, OperatingHours, Staff, StaffService, StaffTimeOff } from '@/lib/types';

// 2026-10-19 is a Monday, 2026-10-25 a Sunday.
const MON = '2026-10-19';
const TUE = '2026-10-20';
const SUN = '2026-10-25';

const week = (open: string, close: string, closedDays: number[] = []): OperatingHours =>
  Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { open, close, closed: closedDays.includes(d) }])
  );

const business = {
  operating_hours: week('09:00', '12:00', [0]), // Sunday closed
  slot_interval_minutes: 30,
};

const NOW = new Date('2026-10-18T08:00:00Z');
const clock: Clock = { date: '2026-10-18', minutes: 8 * 60 }; // the day before MON

const member = (id: string, partial: Partial<Staff> = {}): Staff => ({
  id,
  restaurant_id: 'b1',
  name: id,
  title: null,
  color: '#c9954a',
  working_hours: null,
  active: true,
  sort: 0,
  ...partial,
});

const cut = { id: 'svc-cut', duration_minutes: 30, buffer_minutes: 0 };
const colour = { id: 'svc-colour', duration_minutes: 60, buffer_minutes: 15 };

type Appt = Pick<
  Appointment,
  'id' | 'staff_id' | 'date' | 'start_time' | 'busy_until' | 'status' | 'hold_expires_at'
>;
let seq = 0;
const appt = (staffId: string, start: string, busyUntil: string, partial: Partial<Appt> = {}): Appt => ({
  id: `a${++seq}`,
  staff_id: staffId,
  date: MON,
  start_time: `${start}:00`,
  busy_until: `${busyUntil}:00`,
  status: 'confirmed',
  hold_expires_at: null,
  ...partial,
});

const off = (staffId: string, start: string | null, end: string | null, date = MON): StaffTimeOff => ({
  id: `o${++seq}`,
  restaurant_id: 'b1',
  staff_id: staffId,
  date,
  start_time: start,
  end_time: end,
  reason: null,
});

const slots = (
  staff: Staff,
  service = cut,
  appointments: Appt[] = [],
  timeOff: StaffTimeOff[] = [],
  date = MON,
  at: Clock = clock
) => slotsForStaff({ business, staff, service, date, appointments, timeOff, clock: at, now: NOW });

describe('isLiveAppointment', () => {
  it('confirmed is live, cancelled is not', () => {
    expect(isLiveAppointment({ status: 'confirmed', hold_expires_at: null }, NOW)).toBe(true);
    expect(isLiveAppointment({ status: 'cancelled', hold_expires_at: null }, NOW)).toBe(false);
  });
  it('a payment hold is live only until it runs out', () => {
    const hold = (iso: string | null) => ({ status: 'pending_payment' as const, hold_expires_at: iso });
    expect(isLiveAppointment(hold('2026-10-18T08:10:00Z'), NOW)).toBe(true);
    expect(isLiveAppointment(hold('2026-10-18T07:59:00Z'), NOW)).toBe(false);
    expect(isLiveAppointment(hold(null), NOW)).toBe(false);
  });
});

describe('workingWindow', () => {
  it('follows the business hours when the professional has none', () => {
    expect(workingWindow(business, member('ana'), MON)).toEqual({ open: 540, close: 720 });
    expect(workingWindow(business, member('ana'), SUN)).toBeNull();
  });
  it('uses the professional’s own hours instead of the business’s, even on a closed day', () => {
    const own = member('rui', { working_hours: week('14:00', '18:00', [1]) }); // Monday off
    expect(workingWindow(business, own, MON)).toBeNull();
    expect(workingWindow(business, own, SUN)).toEqual({ open: 840, close: 1080 });
  });
  it('a day missing from the professional’s own hours is a day off', () => {
    const own = member('rui', { working_hours: { '2': { open: '10:00', close: '11:00', closed: false } } });
    expect(workingWindow(business, own, TUE)).toEqual({ open: 600, close: 660 });
    expect(workingWindow(business, own, MON)).toBeNull();
  });
  it('nonsense hours (close before open) mean not working', () => {
    const own = member('rui', { working_hours: week('18:00', '09:00') });
    expect(workingWindow(business, own, MON)).toBeNull();
  });
});

describe('appointmentTimes', () => {
  it('derives end and busy-until from duration and buffer', () => {
    expect(appointmentTimes('10:00', colour)).toEqual({ start: '10:00', end: '11:00', busyUntil: '11:15' });
    expect(appointmentTimes('10:00:00', cut)).toEqual({ start: '10:00', end: '10:30', busyUntil: '10:30' });
  });
  it('refuses a service that would end after midnight', () => {
    expect(appointmentTimes('23:30', colour)).toBeNull();
  });
  it('cuts a buffer that would run past midnight', () => {
    expect(appointmentTimes('23:00', colour)).toEqual({ start: '23:00', end: '24:00', busyUntil: '24:00' });
  });
});

describe('slotsForStaff', () => {
  it('offers every grid start whose service ends by closing time', () => {
    expect(slots(member('ana'))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    // 60 minutes: the last start is 11:00; the buffer may run past closing.
    expect(slots(member('ana'), colour)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });
  it('no slots on a closed day or for a past date', () => {
    expect(slots(member('ana'), cut, [], [], SUN)).toEqual([]);
    expect(slots(member('ana'), cut, [], [], '2026-10-17')).toEqual([]);
  });
  it('removes starts that clash with a live appointment', () => {
    const booked = [appt('ana', '10:00', '10:30')];
    expect(slots(member('ana'), cut, booked)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    // A 60-minute service cannot start at 09:30 either: it would run into 10:00.
    expect(slots(member('ana'), { ...colour, buffer_minutes: 0 }, booked)).toEqual(['09:00', '10:30', '11:00']);
  });
  it('the existing appointment’s buffer keeps the next start free', () => {
    const booked = [appt('ana', '09:00', '10:15')]; // 60 min + 15 buffer
    expect(slots(member('ana'), cut, booked)).toEqual(['10:30', '11:00', '11:30']);
  });
  it('the new service’s own buffer must fit before the next appointment', () => {
    const booked = [appt('ana', '11:00', '11:30')];
    // colour = 60 + 15: starting 10:00 would be busy until 11:15 and clash.
    expect(slots(member('ana'), colour, booked)).toEqual(['09:00', '09:30']);
  });
  it('other professionals’ and other days’ appointments do not count', () => {
    const booked = [appt('rui', '10:00', '10:30'), appt('ana', '10:00', '10:30', { date: TUE })];
    expect(slots(member('ana'), cut, booked)).toHaveLength(6);
  });
  it('cancelled appointments and expired holds free the time; live holds keep it', () => {
    const free = [
      appt('ana', '10:00', '10:30', { status: 'cancelled' }),
      appt('ana', '11:00', '11:30', { status: 'pending_payment', hold_expires_at: '2026-10-18T07:00:00Z' }),
    ];
    expect(slots(member('ana'), cut, free)).toHaveLength(6);
    const held = [
      appt('ana', '11:00', '11:30', { status: 'pending_payment', hold_expires_at: '2026-10-18T08:30:00Z' }),
    ];
    expect(slots(member('ana'), cut, held)).not.toContain('11:00');
  });
  it('timed time off blocks the service, whole-day time off blocks the day', () => {
    expect(slots(member('ana'), cut, [], [off('ana', '10:00:00', '11:00:00')])).toEqual([
      '09:00',
      '09:30',
      '11:00',
      '11:30',
    ]);
    expect(slots(member('ana'), cut, [], [off('ana', null, null)])).toEqual([]);
    // Somebody else's day off changes nothing.
    expect(slots(member('ana'), cut, [], [off('rui', null, null)])).toHaveLength(6);
    // Nor does time off on another date.
    expect(slots(member('ana'), cut, [], [off('ana', null, null, TUE)])).toHaveLength(6);
  });
  it('today only offers starts that are still ahead (business clock)', () => {
    expect(slots(member('ana'), cut, [], [], MON, { date: MON, minutes: 10 * 60 })).toEqual([
      '10:30',
      '11:00',
      '11:30',
    ]);
    expect(slots(member('ana'), cut, [], [], MON, { date: MON, minutes: 10 * 60 + 1 })).toEqual([
      '10:30',
      '11:00',
      '11:30',
    ]);
    expect(slots(member('ana'), cut, [], [], MON, { date: MON, minutes: 12 * 60 })).toEqual([]);
  });
  it('the grid follows the business interval, counted from the professional’s opening time', () => {
    const own = member('rui', { working_hours: week('09:15', '10:15') });
    expect(
      slotsForStaff({
        business: { ...business, slot_interval_minutes: 15 },
        staff: own,
        service: cut,
        date: MON,
        appointments: [],
        timeOff: [],
        clock,
        now: NOW,
      })
    ).toEqual(['09:15', '09:30', '09:45']);
  });
});

describe('eligibleStaff / availableSlots', () => {
  const ana = member('ana', { sort: 1 });
  const rui = member('rui', { sort: 0 });
  const eva = member('eva', { active: false });
  const staff = [ana, rui, eva];
  const links: StaffService[] = [
    { staff_id: 'ana', service_id: 'svc-cut', restaurant_id: 'b1' },
    { staff_id: 'rui', service_id: 'svc-cut', restaurant_id: 'b1' },
    { staff_id: 'eva', service_id: 'svc-cut', restaurant_id: 'b1' },
    { staff_id: 'ana', service_id: 'svc-colour', restaurant_id: 'b1' },
  ];
  const query = (partial: Partial<Parameters<typeof availableSlots>[0]> = {}) =>
    availableSlots({
      business,
      service: cut,
      staff,
      staffServices: links,
      appointments: [],
      timeOff: [],
      date: MON,
      clock,
      now: NOW,
      ...partial,
    });

  it('only active professionals who perform the service are eligible', () => {
    expect(eligibleStaff('svc-cut', staff, links).map((s) => s.id)).toEqual(['ana', 'rui']);
    expect(eligibleStaff('svc-colour', staff, links).map((s) => s.id)).toEqual(['ana']);
    expect(eligibleStaff('svc-colour', staff, links, 'rui')).toEqual([]);
    expect(eligibleStaff('svc-cut', staff, links, 'eva')).toEqual([]);
    expect(eligibleStaff('svc-unknown', staff, links)).toEqual([]);
  });
  it('“any professional” is the union, with who is free at each time', () => {
    const result = query({
      appointments: [appt('ana', '09:00', '09:30'), appt('ana', '10:00', '10:30'), appt('rui', '10:00', '10:30')],
    });
    expect(result.map((s) => s.time)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
    expect(result[0]).toEqual({ time: '09:00', staffIds: ['rui'] });
    expect(result[1].staffIds).toEqual(['ana', 'rui']);
  });
  it('a specific professional only gets their own slots', () => {
    const result = query({ staffId: 'ana', appointments: [appt('ana', '09:00', '09:30')] });
    expect(result.map((s) => s.time)).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(result.every((s) => s.staffIds.length === 1 && s.staffIds[0] === 'ana')).toBe(true);
  });
  it('a professional who does not perform the service yields nothing', () => {
    expect(query({ service: colour, staffId: 'rui' })).toEqual([]);
    expect(query({ staffId: 'eva' })).toEqual([]);
  });
});

describe('rankStaff', () => {
  const staff = [
    { id: 'ana', sort: 2 },
    { id: 'rui', sort: 1 },
    { id: 'eva', sort: 1 },
  ];
  it('fewest live appointments that day first, then the owner’s order, then id', () => {
    const appointments = [
      appt('rui', '09:00', '09:30'),
      appt('rui', '10:00', '10:30'),
      appt('ana', '09:00', '09:30'),
      appt('eva', '09:00', '09:30', { status: 'cancelled' }),
      appt('eva', '09:00', '09:30', { date: TUE }),
    ];
    expect(rankStaff(['ana', 'rui', 'eva'], staff, appointments, MON, NOW)).toEqual(['eva', 'ana', 'rui']);
  });
  it('ties fall back to sort, then id, and the input is not mutated', () => {
    const input = ['ana', 'rui', 'eva'];
    expect(rankStaff(input, staff, [], MON, NOW)).toEqual(['eva', 'rui', 'ana']);
    expect(input).toEqual(['ana', 'rui', 'eva']);
  });
});

describe('staffIsFree (owner edits)', () => {
  const booked = [appt('ana', '10:00', '10:45')];
  it('detects a clash, including the existing appointment’s buffer', () => {
    expect(staffIsFree('ana', MON, 9 * 60 + 30, cut, booked, [], NOW)).toBe(true);
    expect(staffIsFree('ana', MON, 10 * 60 + 30, cut, booked, [], NOW)).toBe(false);
    expect(staffIsFree('ana', MON, 10 * 60 + 45, cut, booked, [], NOW)).toBe(true);
  });
  it('ignores the appointment being edited', () => {
    expect(staffIsFree('ana', MON, 10 * 60, cut, booked, [], NOW, booked[0].id)).toBe(true);
  });
  it('does not look at working hours: owners may book outside them', () => {
    expect(staffIsFree('ana', SUN, 22 * 60, cut, [], [], NOW)).toBe(true);
  });
});
