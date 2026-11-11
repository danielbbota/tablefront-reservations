// iCalendar reading/writing and the decision of what a channel feed changes.
import { describe, expect, it } from 'vitest';
import {
  IcalParseError,
  describeChannelEvent,
  generateIcal,
  parseIcal,
  planSync,
  type IcalEvent,
} from '@/lib/stays/ical';

const AIRBNB = [
  'BEGIN:VCALENDAR',
  'PRODID;X-RICAL-TZSOURCE=TZINFO:-//Airbnb Inc//Hosting Calendar 1.0//EN',
  'CALSCALE:GREGORIAN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTAMP:20300101T000000Z',
  'DTSTART;VALUE=DATE:20300712',
  'DTEND;VALUE=DATE:20300716',
  'SUMMARY:Reserved',
  'UID:1418fb94e984-aaa@airbnb.com',
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de',
  ' tails/HMABCD1234\\nPhone Number (Last 4 Digits): 9876',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20300801',
  'DTEND;VALUE=DATE:20300803',
  'SUMMARY:Airbnb (Not available)',
  'UID:6fec1092d3fa-bbb@airbnb.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const BOOKING = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20300905',
  'DTEND;VALUE=DATE:20300907',
  'UID:abc123@booking.com',
  'SUMMARY:CLOSED - Not available',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n');

const ev = (over: Partial<IcalEvent>): IcalEvent => ({
  uid: 'u1',
  start: '2030-07-12',
  end: '2030-07-16',
  summary: 'Reserved',
  description: '',
  status: '',
  ...over,
});

describe('parseIcal', () => {
  it('reads an Airbnb export, unfolding long lines', () => {
    const events = parseIcal(AIRBNB);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      uid: '1418fb94e984-aaa@airbnb.com',
      start: '2030-07-12',
      end: '2030-07-16',
      summary: 'Reserved',
    });
    expect(events[0].description).toContain('reservations/details/HMABCD1234');
    expect(events[0].description).toContain('Last 4 Digits): 9876');
  });

  it('reads a Booking.com export with bare newlines', () => {
    expect(parseIcal(BOOKING)).toEqual([
      {
        uid: 'abc123@booking.com',
        start: '2030-09-05',
        end: '2030-09-07',
        summary: 'CLOSED - Not available',
        description: '',
        status: '',
      },
    ]);
  });

  it('takes the date from date-time values and gives a one-night stay when DTEND is missing or not after DTSTART', () => {
    const cal = (body: string[]) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...body, 'END:VEVENT', 'END:VCALENDAR'].join('\n');
    expect(parseIcal(cal(['UID:a', 'DTSTART:20300301T150000Z', 'DTEND:20300303T100000Z']))[0]).toMatchObject({
      start: '2030-03-01',
      end: '2030-03-03',
    });
    expect(parseIcal(cal(['UID:b', 'DTSTART;VALUE=DATE:20300301']))[0].end).toBe('2030-03-02');
    expect(parseIcal(cal(['UID:c', 'DTSTART;VALUE=DATE:20300301', 'DTEND;VALUE=DATE:20300301']))[0].end).toBe('2030-03-02');
  });

  it('skips events it cannot place and keeps the rest', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20300301', 'END:VEVENT', // no UID
      'BEGIN:VEVENT', 'UID:x', 'DTSTART;VALUE=DATE:20301340', 'END:VEVENT', // impossible date
      'BEGIN:VEVENT', 'UID:ok', 'DTSTART;VALUE=DATE:20300301', 'DTEND;VALUE=DATE:20300302', 'STATUS:cancelled', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    expect(parseIcal(text)).toEqual([expect.objectContaining({ uid: 'ok', status: 'CANCELLED' })]);
  });

  it('an empty calendar is valid; something that is not a calendar is an error', () => {
    expect(parseIcal('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR')).toEqual([]);
    expect(() => parseIcal('<html><body>Sign in</body></html>')).toThrow(IcalParseError);
    expect(() => parseIcal('')).toThrow(IcalParseError);
  });
});

describe('describeChannelEvent', () => {
  it('Airbnb: a reservation carries its code, link and phone hint', () => {
    const info = describeChannelEvent('airbnb', parseIcal(AIRBNB)[0]);
    expect(info).toEqual({
      label: 'Airbnb HMABCD1234',
      externalRef: 'https://www.airbnb.com/hosting/reservations/details/HMABCD1234',
      blockOnly: false,
      notes: 'Airbnb · tel. …9876',
    });
  });
  it('Airbnb: "Not available" is a closed date, not a guest', () => {
    expect(describeChannelEvent('airbnb', parseIcal(AIRBNB)[1])).toMatchObject({
      label: 'Airbnb (Not available)',
      blockOnly: true,
    });
  });
  it('Booking.com: every event may be a guest', () => {
    expect(describeChannelEvent('booking', parseIcal(BOOKING)[0])).toMatchObject({
      label: 'CLOSED - Not available',
      blockOnly: false,
    });
  });
});

describe('planSync', () => {
  const TODAY = '2030-07-01';
  const NOW = new Date('2030-07-01T10:00:00Z');
  const existing = (over: Record<string, unknown> = {}) => ({
    id: 'res-1',
    external_uid: 'u1',
    check_in: '2030-07-12',
    check_out: '2030-07-16',
    status: 'confirmed' as const,
    hold_expires_at: null,
    ...over,
  });

  it('imports a reservation it has not seen', () => {
    const plan = planSync('booking', [ev({ summary: 'CLOSED - Not available' })], [], [], TODAY, NOW);
    expect(plan.inserts).toEqual([
      {
        external_uid: 'u1',
        check_in: '2030-07-12',
        check_out: '2030-07-16',
        guest_name: 'CLOSED - Not available',
        external_ref: null,
        notes: null,
      },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.cancels).toEqual([]);
  });

  it('changes nothing when the feed matches what we hold', () => {
    const plan = planSync('airbnb', [ev({})], [existing()], [], TODAY, NOW);
    expect(plan).toMatchObject({ inserts: [], updates: [], cancels: [] });
  });

  it('moves a reservation whose dates changed on the channel', () => {
    const plan = planSync('airbnb', [ev({ end: '2030-07-18' })], [existing()], [], TODAY, NOW);
    expect(plan.updates).toEqual([{ id: 'res-1', check_in: '2030-07-12', check_out: '2030-07-18' }]);
  });

  it('revives a reservation we had cancelled if the channel still lists it', () => {
    const plan = planSync('airbnb', [ev({})], [existing({ status: 'cancelled' })], [], TODAY, NOW);
    expect(plan.updates).toHaveLength(1);
  });

  it('cancels a future reservation that disappeared from the feed or is marked CANCELLED', () => {
    expect(planSync('airbnb', [], [existing()], [], TODAY, NOW).cancels).toEqual(['res-1']);
    expect(planSync('airbnb', [ev({ status: 'CANCELLED' })], [existing()], [], TODAY, NOW).cancels).toEqual(['res-1']);
  });

  it('leaves finished stays alone: channels drop past events from their feeds', () => {
    const past = existing({ check_in: '2030-06-20', check_out: '2030-06-25' });
    expect(planSync('airbnb', [], [past], [], TODAY, NOW).cancels).toEqual([]);
    expect(planSync('airbnb', [ev({ start: '2030-06-20', end: '2030-06-25' })], [], [], TODAY, NOW).inserts).toEqual([]);
  });

  it('never imports events that came out of TableFront', () => {
    const plan = planSync('other', [ev({ uid: 'res-123@tablefront' })], [], [], TODAY, NOW);
    expect(plan.inserts).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('imports each UID once even if the feed repeats it', () => {
    expect(planSync('booking', [ev({}), ev({})], [], [], TODAY, NOW).inserts).toHaveLength(1);
  });

  describe('a channel echoing a calendar it imported from us', () => {
    const direct = [{ check_in: '2030-07-10', check_out: '2030-07-20', status: 'confirmed' as const, hold_expires_at: null }];
    const blocked = ev({ uid: 'echo', summary: 'Airbnb (Not available)' });

    it('skips an Airbnb "Not available" marker fully covered by our own reservation', () => {
      const plan = planSync('airbnb', [blocked], [], direct, TODAY, NOW);
      expect(plan.inserts).toEqual([]);
      expect(plan.skipped).toBe(1);
    });
    it('imports it when some night is not covered: the owner closed dates on Airbnb', () => {
      const plan = planSync('airbnb', [ev({ uid: 'echo', summary: 'Airbnb (Not available)', end: '2030-07-22' })], [], direct, TODAY, NOW);
      expect(plan.inserts).toHaveLength(1);
    });
    it('never hides a real guest, even on nights we already sold: that is a double booking', () => {
      expect(planSync('airbnb', [ev({ uid: 'guest', summary: 'Reserved' })], [], direct, TODAY, NOW).inserts).toHaveLength(1);
      expect(planSync('booking', [ev({ uid: 'guest', summary: 'CLOSED - Not available' })], [], direct, TODAY, NOW).inserts).toHaveLength(1);
    });
    it('a cancelled reservation of ours covers nothing', () => {
      const cancelled = [{ ...direct[0], status: 'cancelled' as const }];
      expect(planSync('airbnb', [blocked], [], cancelled, TODAY, NOW).inserts).toHaveLength(1);
    });
  });
});

describe('generateIcal', () => {
  const text = generateIcal(
    'Casa Azul — Sea room, top floor',
    [
      { uid: 'res-1', start: '2030-07-12', end: '2030-07-16', summary: 'Reserved' },
      { uid: 'block-9', start: '2030-08-01', end: '2030-08-03', summary: 'Not available' },
    ],
    new Date('2030-01-02T03:04:05Z')
  );

  it('writes all-day events with CRLF line ends and no guest data', () => {
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('DTSTART;VALUE=DATE:20300712\r\nDTEND;VALUE=DATE:20300716');
    expect(text).toContain('DTSTAMP:20300102T030405Z');
    expect(text).toContain('X-WR-CALNAME:Casa Azul — Sea room\\, top floor');
  });

  it('round-trips through the parser, marked as ours', () => {
    expect(parseIcal(text)).toEqual([
      expect.objectContaining({ uid: 'res-1@tablefront', start: '2030-07-12', end: '2030-07-16', summary: 'Reserved' }),
      expect.objectContaining({ uid: 'block-9@tablefront', start: '2030-08-01', end: '2030-08-03' }),
    ]);
    // …so importing our own export back changes nothing.
    expect(planSync('other', parseIcal(text), [], [], '2030-01-01').inserts).toEqual([]);
  });
});
