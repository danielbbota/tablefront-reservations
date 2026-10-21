// =============================================================================
// Booking flow, locked in as it behaves TODAY (2026-10-21), hermetically.
//
// Exercises the real route handler (POST /api/public/bookings), the real
// availability handler, the real server actions (createManualBooking,
// saveSettings) and the real email module, against:
//   - tests/helpers/fake-supabase.ts: an in-memory PostgREST + schema fake that
//     mirrors create_widget_booking() from migration 0003 and the RLS policies,
//   - a mocked `resend` package (nothing is ever sent).
//
// Covers: (1) a guest books a slot with name, phone, email, date, time, party
// size and notes; (2) the slot cap rejects bookings; (3) owner-set caps per
// day/slot are respected and the manual (dashboard) override works; (4) tenant
// scoping; (5) the confirmation email.
//
// Tests marked `it.fails` describe the CORRECT behaviour where today's code is
// wrong, each with the AUDIT.md item. They pass while the bug exists and will
// start failing (and must be flipped to `it`) once the fix lands. Nothing in
// the app is changed by this file.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FakeDb, type Row } from '../helpers/fake-supabase';
import type { Booking } from '@/lib/types';

// --- mocks (hoisted by Vitest; factories run lazily on first import) ---------

const db = new FakeDb();
let currentUserId: string | null = null;

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.asAdmin() }));
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => db.asOwner(currentUserId ?? 'nobody'),
}));

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

type SendArgs = { from: string; to: string; subject: string; text: string };
type SendResult = { data: { id: string } | null; error: { message: string; name: string } | null };
const emailsSend = vi.fn<(args: SendArgs) => Promise<SendResult>>(async () => ({ data: { id: `email_${randomUUID()}` }, error: null }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: emailsSend };
  },
}));

const { POST: postBooking } = await import('@/app/api/public/bookings/route');
const { GET: getAvailability } = await import('@/app/api/public/availability/route');
const { createManualBooking, saveSettings } = await import('@/app/actions');

// --- fixtures ----------------------------------------------------------------

const APP_URL = 'http://localhost:3100';
const EMAIL_FROM = 'TableFront Tests <onboarding@resend.dev>';

// Frozen clock: 2026-10-21 19:30 UTC = 20:30 in Lisbon (WEST, UTC+1 until Oct 25).
const NOW = new Date('2026-10-21T19:30:00Z');
const TODAY = '2026-10-21';
const MONDAY = '2026-10-26'; // 5 days ahead, day_of_week 1
const TUESDAY = '2026-10-27';
const SUNDAY = '2026-10-25'; // closed in the fixture

const OPEN_18_22 = { open: '18:00', close: '22:00', closed: false };
const HOURS = {
  '0': { open: '18:00', close: '22:00', closed: true },
  '1': OPEN_18_22,
  '2': OPEN_18_22,
  '3': OPEN_18_22,
  '4': OPEN_18_22,
  '5': OPEN_18_22,
  '6': OPEN_18_22,
};

let A: Row; // restaurant under test, cap 10
let B: Row; // another tenant, cap 10
let ownerA: Row;
let ownerB: Row;

function seedTenants() {
  for (const t of Object.keys(db.tables)) db.tables[t] = [];
  db.rpcCalls = [];
  A = db.seed('restaurants', {
    name: 'Casa Alpha',
    slug: 'casa-alpha',
    timezone: 'Europe/Lisbon',
    slot_interval_minutes: 30,
    operating_hours: HOURS,
    default_max_covers: 10,
    language: 'en',
  });
  B = db.seed('restaurants', {
    name: 'Bistro Beta',
    slug: 'bistro-beta',
    timezone: 'Europe/Lisbon',
    slot_interval_minutes: 30,
    operating_hours: HOURS,
    default_max_covers: 10,
    language: 'en',
  });
  ownerA = db.seed('owners', { id: randomUUID(), restaurant_id: A.id, email: 'owner-a@example.test' });
  ownerB = db.seed('owners', { id: randomUUID(), restaurant_id: B.id, email: 'owner-b@example.test' });
}

const guest = {
  name: 'Ada Lovelace',
  phone: '+351 910 000 000',
  email: 'ada@example.test',
  notes: 'Window seat, please',
};

function post(body: Record<string, unknown>) {
  return postBooking(
    new NextRequest(new URL('/api/public/bookings', APP_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** A complete, valid widget booking for restaurant A; override what a test needs. */
const book = (overrides: Record<string, unknown> = {}) =>
  post({ restaurant: A.id, date: MONDAY, time: '19:00', partySize: 4, ...guest, ...overrides });

async function remaining(restaurantId: string, date: string): Promise<Map<string, number>> {
  const url = new URL('/api/public/availability', APP_URL);
  url.searchParams.set('restaurant', restaurantId);
  url.searchParams.set('date', date);
  const res = await getAvailability(new NextRequest(url));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { slots: { time: string; remaining: number }[] };
  return new Map(body.slots.map((s) => [s.time, s.remaining]));
}

/** Seed a confirmed booking directly (as the database would hold it). */
function seedBooking(overrides: Row): Row {
  return db.seed('bookings', {
    restaurant_id: A.id,
    guest_name: 'Seeded Guest',
    guest_phone: '+351 900 000 000',
    guest_email: 'seeded@example.test',
    party_size: 2,
    date: MONDAY,
    time_slot: '19:00',
    status: 'confirmed',
    source: 'widget',
    ...overrides,
  });
}

const bookingsAt = (restaurantId: string, date: string, time: string) =>
  db.tables.bookings.filter((b) => b.restaurant_id === restaurantId && b.date === date && b.time_slot === `${time}:00`);

/** Run a form-bound server action and return where it redirected. */
async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.to;
    throw e;
  }
  throw new Error('server action returned without redirecting');
}

function manualForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function settingsForm(overrides: Record<string, string> = {}): FormData {
  const fields: Record<string, string> = {
    slotInterval: '30',
    defaultMaxCovers: '10',
    turnTime: '90',
    timezone: 'Europe/Lisbon',
    language: 'en',
    closed_0: 'on',
  };
  for (let d = 0; d < 7; d++) {
    fields[`open_${d}`] = '18:00';
    fields[`close_${d}`] = '22:00';
    fields[`cap_${d}`] = '';
  }
  return manualForm({ ...fields, ...overrides });
}

const sentTo = (to: string) => emailsSend.mock.calls.map(([args]) => args).filter((a) => a.to === to);

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('EMAIL_FROM', EMAIL_FROM);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('RESEND_API_KEY', 're_test_dummy_key');
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  seedTenants();
  currentUserId = ownerA.id as string;
  emailsSend.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// 1. Guest books a slot
// =============================================================================
describe('1. a guest books a slot with name, phone, email, date, time, party size and notes', () => {
  it('stores every field under the booked restaurant and answers 201 with the booking summary', async () => {
    const res = await book({ name: '  Ada Lovelace  ', lang: 'pt' });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const { booking } = (await res.json()) as { booking: Record<string, unknown> };
    expect(booking).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      date: MONDAY,
      time: '19:00',
      partySize: 4,
      status: 'confirmed',
    });

    const [row] = bookingsAt(A.id as string, MONDAY, '19:00');
    expect(row).toMatchObject({
      id: booking.id,
      restaurant_id: A.id,
      guest_name: 'Ada Lovelace', // trimmed
      guest_phone: guest.phone,
      guest_email: guest.email,
      party_size: 4,
      date: MONDAY,
      time_slot: '19:00:00',
      notes: guest.notes,
      status: 'confirmed',
      source: 'widget',
      guest_lang: 'pt',
      service_status: null,
      reminder_sent_at: null,
    });
    expect(row.cancel_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hands the database function exactly the guest data plus the resolved cap and language', async () => {
    await book({ lang: 'pt' });
    expect(db.rpcCalls).toEqual([
      {
        name: 'create_widget_booking',
        args: {
          p_restaurant_id: A.id,
          p_date: MONDAY,
          p_time_slot: '19:00',
          p_party_size: 4,
          p_guest_name: guest.name,
          p_guest_phone: guest.phone,
          p_guest_email: guest.email,
          p_notes: guest.notes,
          p_max_covers: 10, // restaurant default, no rules
          p_guest_lang: 'pt',
        },
      },
    ]);
  });

  it('notes are optional, trimmed and cut at 1000 characters', async () => {
    expect((await book({ notes: '   ' })).status).toBe(201);
    expect((await book({ notes: undefined, time: '19:30' })).status).toBe(201);
    expect((await book({ notes: `  ${'x'.repeat(1200)}  `, time: '20:00' })).status).toBe(201);

    expect(bookingsAt(A.id as string, MONDAY, '19:00')[0].notes).toBeNull();
    expect(bookingsAt(A.id as string, MONDAY, '19:30')[0].notes).toBeNull();
    expect((bookingsAt(A.id as string, MONDAY, '20:00')[0].notes as string).length).toBe(1000);
  });

  it('falls back to the restaurant language when the guest sends none or an unsupported one', async () => {
    db.tables.restaurants.find((r) => r.id === A.id)!.language = 'de';
    expect((await book({ lang: undefined })).status).toBe(201);
    expect((await book({ lang: 'xx', time: '19:30' })).status).toBe(201);
    expect(bookingsAt(A.id as string, MONDAY, '19:00')[0].guest_lang).toBe('de');
    expect(bookingsAt(A.id as string, MONDAY, '19:30')[0].guest_lang).toBe('de');
  });

  it.each([
    ['a time that is not on the slot grid', { time: '19:15' }, 400, /not available for booking/],
    ['the first slot after closing', { time: '22:00' }, 400, /not available for booking/],
    ['a closed day', { date: SUNDAY }, 400, /not available for booking/],
    ['a slot earlier today (restaurant-local time)', { date: TODAY, time: '20:00' }, 400, /already passed/],
    ['yesterday', { date: '2026-10-20' }, 400, /not bookable/],
    ['the day after the 60-day horizon', { date: '2026-12-21' }, 400, /not bookable/],
    ['an unknown restaurant', { restaurant: '00000000-0000-0000-0000-000000000000' }, 404, /Restaurant not found/],
  ])('refuses %s without calling the booking function', async (_label, overrides, status, message) => {
    const res = await book(overrides);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(message);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.tables.bookings).toHaveLength(0);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it('still accepts the last slot of the day, a slot later today and the last day of the horizon', async () => {
    expect((await book({ time: '21:30' })).status).toBe(201);
    expect((await book({ date: TODAY, time: '21:00' })).status).toBe(201);
    // 2026-12-20 (today + 60) is a Sunday: open it so only the horizon is under test.
    db.tables.restaurants.find((r) => r.id === A.id)!.operating_hours = { ...HOURS, '0': OPEN_18_22 };
    expect((await book({ date: '2026-12-20', time: '18:00' })).status).toBe(201);
  });

  // AUDIT.md L1: "Impossible dates cause 500 errors". 2026-11-31 passes the
  // regex and the horizon string compare, reaches Postgres and fails there,
  // so the guest gets a 500 instead of a 400 and the function is called for
  // nothing. Correct behaviour: validate the calendar date up front.
  it.fails('AUDIT L1: an impossible calendar date is refused with 400 before the booking function is called', async () => {
    const res = await book({ date: '2026-11-31' });
    expect(res.status).toBe(400);
    expect(db.rpcCalls).toHaveLength(0);
  });
});

// =============================================================================
// 2. Booking is rejected when the slot cap is reached
// =============================================================================
describe('2. a booking is rejected when the slot cap is reached', () => {
  it('refuses a party that would exceed the cap with 409 SLOT_FULL, writes nothing and sends nothing', async () => {
    seedBooking({ party_size: 8 }); // 8 of 10 taken at 19:00
    const res = await book({ partySize: 3 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Sorry, that time just filled up. Please pick another slot.',
      code: 'SLOT_FULL',
    });
    expect(bookingsAt(A.id as string, MONDAY, '19:00')).toHaveLength(1);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it('accepts a party that lands exactly on the cap, then refuses even one more cover', async () => {
    seedBooking({ party_size: 8 });
    expect((await book({ partySize: 2 })).status).toBe(201);
    expect((await book({ partySize: 1 })).status).toBe(409);
    const covers = bookingsAt(A.id as string, MONDAY, '19:00').reduce((s, b) => s + (b.party_size as number), 0);
    expect(covers).toBe(10);
  });

  it('cancelled bookings do not count toward the cap', async () => {
    seedBooking({ party_size: 10, status: 'cancelled' });
    expect((await book({ partySize: 10 })).status).toBe(201);
  });

  it('manual (dashboard) bookings count toward the online cap', async () => {
    seedBooking({ party_size: 10, source: 'manual' });
    expect((await book({ partySize: 1 })).status).toBe(409);
  });

  it('a full slot leaves the neighbouring slots and other days untouched', async () => {
    seedBooking({ party_size: 10 });
    expect((await book({ partySize: 1 })).status).toBe(409);
    expect((await book({ partySize: 10, time: '19:30' })).status).toBe(201);
    expect((await book({ partySize: 10, date: TUESDAY })).status).toBe(201);
  });

  it('availability reports 0 remaining for the full slot and the full cap elsewhere', async () => {
    seedBooking({ party_size: 7 });
    seedBooking({ party_size: 3 });
    const slots = await remaining(A.id as string, MONDAY);
    expect([...slots.keys()]).toEqual(['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30']);
    expect(slots.get('19:00')).toBe(0);
    expect(slots.get('19:30')).toBe(10);
  });

  it('a default cap of 0 closes every slot to online bookings', async () => {
    db.tables.restaurants.find((r) => r.id === A.id)!.default_max_covers = 0;
    expect((await book({ partySize: 1 })).status).toBe(409);
    expect([...(await remaining(A.id as string, MONDAY)).values()].every((n) => n === 0)).toBe(true);
  });

  // AUDIT.md M3: capacity is counted per exact slot string. A confirmed
  // booking at 19:15 (off the 30-minute grid, e.g. a manual booking) is
  // invisible to the 19:00 slot, so the widget still shows 10 free covers.
  // Correct behaviour: covers whose start falls inside [slot, slot+interval)
  // count toward that slot.
  it.fails('AUDIT M3: availability counts off-grid confirmed covers against the slot window they fall into', async () => {
    seedBooking({ party_size: 10, time_slot: '19:15', source: 'manual' });
    expect((await remaining(A.id as string, MONDAY)).get('19:00')).toBe(0);
  });
});

// =============================================================================
// 3. Owner-set cap per time slot, and the manual override
// =============================================================================
describe('3. the owner-set cap per time slot is respected and the manual override works', () => {
  it('a per-day cap saved in Settings becomes the cap the widget enforces for that weekday', async () => {
    expect(await redirectOf(saveSettings(settingsForm({ cap_1: '6' })))).toBe('/settings?saved=1');
    expect(db.tables.capacity_rules).toEqual([
      expect.objectContaining({ restaurant_id: A.id, day_of_week: 1, specific_date: null, time_slot: null, max_covers: 6 }),
    ]);

    expect((await remaining(A.id as string, MONDAY)).get('19:00')).toBe(6);
    expect((await remaining(A.id as string, TUESDAY)).get('19:00')).toBe(10);

    expect((await book({ partySize: 7 })).status).toBe(409); // Monday, cap 6
    expect((await book({ partySize: 6 })).status).toBe(201);
    expect((await book({ partySize: 7, date: TUESDAY })).status).toBe(201); // Tuesday keeps the default
    expect(db.rpcCalls.map((c) => c.args.p_max_covers)).toEqual([6, 6, 10]);
  });

  it('clearing the per-day cap in Settings restores the restaurant default', async () => {
    await redirectOf(saveSettings(settingsForm({ cap_1: '6' })));
    expect(await redirectOf(saveSettings(settingsForm({ cap_1: '' })))).toBe('/settings?saved=1');
    expect(db.tables.capacity_rules).toEqual([]);
    expect((await book({ partySize: 7 })).status).toBe(201);
  });

  it('changing the default cap in Settings applies to every slot without a rule', async () => {
    expect(await redirectOf(saveSettings(settingsForm({ defaultMaxCovers: '3' })))).toBe('/settings?saved=1');
    expect(db.tables.restaurants.find((r) => r.id === A.id)!.default_max_covers).toBe(3);
    expect((await book({ partySize: 4 })).status).toBe(409);
    expect((await book({ partySize: 3 })).status).toBe(201);
  });

  it('Settings rejects a negative or non-integer cap and changes nothing', async () => {
    expect(await redirectOf(saveSettings(settingsForm({ cap_1: '-1' })))).toMatch(/^\/settings\?error=Invalid%20cap%20override%20for%20Monday/);
    expect(await redirectOf(saveSettings(settingsForm({ defaultMaxCovers: '2.5' })))).toMatch(/^\/settings\?error=Default%20max%20covers/);
    expect(db.tables.capacity_rules).toEqual([]);
    expect(db.tables.restaurants.find((r) => r.id === A.id)!.default_max_covers).toBe(10);
  });

  it('a per-slot rule applies to that slot only; a date-specific rule for the slot beats it', async () => {
    // The dashboard edits day-of-week rules only, but the schema and resolver
    // support these finer rules and the booking route honours them today.
    db.seed('capacity_rules', { restaurant_id: A.id, day_of_week: 1, time_slot: '19:00', max_covers: 4 });
    db.seed('capacity_rules', { restaurant_id: A.id, day_of_week: 1, max_covers: 8 });

    expect((await book({ partySize: 5, time: '19:00' })).status).toBe(409); // dow+slot rule: 4
    expect((await book({ partySize: 5, time: '19:30' })).status).toBe(201); // dow rule: 8
    expect((await book({ partySize: 4, time: '19:30' })).status).toBe(409); // 5 + 4 > 8

    db.seed('capacity_rules', { restaurant_id: A.id, specific_date: MONDAY, time_slot: '19:00', max_covers: 12 });
    expect((await book({ partySize: 5, time: '19:00' })).status).toBe(201); // date+slot rule: 12
    expect(db.rpcCalls.map((c) => c.args.p_max_covers)).toEqual([4, 8, 8, 12]);
  });

  it('manual override: the owner can book a full slot from the dashboard; the booking is stored in full and bypasses the capped function', async () => {
    seedBooking({ party_size: 10 }); // 19:00 is full for the widget
    expect((await book({ partySize: 1 })).status).toBe(409);
    const callsBefore = db.rpcCalls.length;

    const to = await redirectOf(
      createManualBooking(
        manualForm({
          date: MONDAY,
          time: '19:00',
          partySize: '6',
          name: '  Grace Hopper ',
          phone: '+351 920 000 000',
          email: 'grace@example.test',
          notes: ' Birthday ',
          table: 'T7',
        })
      )
    );
    expect(to).toBe('/');

    const manual = bookingsAt(A.id as string, MONDAY, '19:00').find((b) => b.source === 'manual');
    expect(manual).toMatchObject({
      restaurant_id: A.id,
      guest_name: 'Grace Hopper',
      guest_phone: '+351 920 000 000',
      guest_email: 'grace@example.test',
      party_size: 6,
      date: MONDAY,
      time_slot: '19:00:00',
      notes: 'Birthday',
      table_number: 'T7',
      status: 'confirmed',
      source: 'manual',
      guest_lang: 'en', // restaurant language
    });
    expect(db.rpcCalls).toHaveLength(callsBefore); // never goes through create_widget_booking
    expect(emailsSend).not.toHaveBeenCalled(); // no guest confirmation for manual bookings today

    // The over-cap slot now shows 0 online, and the widget stays blocked.
    expect((await remaining(A.id as string, MONDAY)).get('19:00')).toBe(0);
    expect((await book({ partySize: 1 })).status).toBe(409);
  });

  it('manual override is not bounded by the online party-size limit or the slot grid', async () => {
    expect(await redirectOf(createManualBooking(manualForm({ date: MONDAY, time: '19:15', partySize: '20', name: 'Big Table' })))).toBe('/');
    expect(db.tables.bookings).toEqual([
      expect.objectContaining({ restaurant_id: A.id, party_size: 20, time_slot: '19:15:00', source: 'manual', guest_phone: '', guest_email: '' }),
    ]);
  });

  it.each([
    ['a missing name', { date: MONDAY, time: '19:00', partySize: '2', name: '  ' }, 'Guest name is required.'],
    ['a malformed date', { date: '26/10/2026', time: '19:00', partySize: '2', name: 'X' }, 'A date is required.'],
    ['a malformed time', { date: MONDAY, time: '7pm', partySize: '2', name: 'X' }, 'A time is required.'],
    ['a party size of 0', { date: MONDAY, time: '19:00', partySize: '0', name: 'X' }, 'Invalid party size.'],
    ['a fractional party size', { date: MONDAY, time: '19:00', partySize: '2.5', name: 'X' }, 'Invalid party size.'],
  ])('the manual booking form rejects %s and stores nothing', async (_label, fields, message) => {
    expect(await redirectOf(createManualBooking(manualForm(fields)))).toBe(`/bookings/new?error=${encodeURIComponent(message)}`);
    expect(db.tables.bookings).toHaveLength(0);
  });
});

// =============================================================================
// 4. Tenant scoping
// =============================================================================
describe('4. a booking is scoped to the correct tenant', () => {
  it('a guest booking is written to the restaurant in the request and counts only against that restaurant', async () => {
    seedBooking({ restaurant_id: B.id, party_size: 10 }); // B is full at 19:00

    const res = await book({ restaurant: A.id, partySize: 4 });
    expect(res.status).toBe(201);
    expect(db.rpcCalls.at(-1)?.args.p_restaurant_id).toBe(A.id);
    expect(bookingsAt(A.id as string, MONDAY, '19:00')).toEqual([expect.objectContaining({ restaurant_id: A.id, party_size: 4 })]);
    expect(bookingsAt(B.id as string, MONDAY, '19:00')).toHaveLength(1);

    expect((await remaining(A.id as string, MONDAY)).get('19:00')).toBe(6);
    expect((await remaining(B.id as string, MONDAY)).get('19:00')).toBe(0);
    expect((await book({ restaurant: B.id, partySize: 1 })).status).toBe(409);
  });

  it("restaurant B's capacity rules never change restaurant A's cap", async () => {
    db.seed('capacity_rules', { restaurant_id: B.id, day_of_week: 1, max_covers: 1 });
    expect((await book({ restaurant: A.id, partySize: 5 })).status).toBe(201);
    expect(db.rpcCalls.at(-1)?.args.p_max_covers).toBe(10);
    expect((await book({ restaurant: B.id, partySize: 2 })).status).toBe(409);
  });

  it('the new-booking notice goes to the owner of the booked restaurant only', async () => {
    expect((await book({ restaurant: A.id })).status).toBe(201);
    expect(sentTo(ownerA.email as string)).toHaveLength(1);
    expect(sentTo(ownerB.email as string)).toHaveLength(0);

    expect((await book({ restaurant: B.id })).status).toBe(201);
    expect(sentTo(ownerA.email as string)).toHaveLength(1);
    expect(sentTo(ownerB.email as string)).toHaveLength(1);
  });

  it("a manual booking is always filed under the logged-in owner's restaurant, whatever the form says", async () => {
    currentUserId = ownerA.id as string;
    const to = await redirectOf(
      createManualBooking(
        manualForm({
          date: MONDAY,
          time: '19:00',
          partySize: '2',
          name: 'Spoofed',
          restaurant_id: B.id as string,
          restaurantId: B.id as string,
          restaurant: B.id as string,
        })
      )
    );
    expect(to).toBe('/');
    expect(db.tables.bookings).toEqual([expect.objectContaining({ restaurant_id: A.id, guest_name: 'Spoofed' })]);
  });

  it('owner B creating a manual booking lands in B, never in A', async () => {
    currentUserId = ownerB.id as string;
    await redirectOf(createManualBooking(manualForm({ date: MONDAY, time: '19:00', partySize: '2', name: 'Beta Guest' })));
    expect(db.tables.bookings).toEqual([expect.objectContaining({ restaurant_id: B.id })]);
    expect((await remaining(A.id as string, MONDAY)).get('19:00')).toBe(10);
  });

  it('a signed-in user with no owners row cannot create a manual booking', async () => {
    currentUserId = randomUUID();
    expect(await redirectOf(createManualBooking(manualForm({ date: MONDAY, time: '19:00', partySize: '2', name: 'Nobody' })))).toBe(
      `/bookings/new?error=${encodeURIComponent('Not logged in.')}`
    );
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("owner A's settings changes never touch restaurant B", async () => {
    currentUserId = ownerA.id as string;
    await redirectOf(saveSettings(settingsForm({ defaultMaxCovers: '1', cap_1: '2' })));
    expect(db.tables.restaurants.find((r) => r.id === A.id)!.default_max_covers).toBe(1);
    expect(db.tables.restaurants.find((r) => r.id === B.id)!.default_max_covers).toBe(10);
    expect(db.tables.capacity_rules.every((r) => r.restaurant_id === A.id)).toBe(true);
  });
});

// =============================================================================
// 5. Confirmation email (Resend mocked)
// =============================================================================
describe('5. a confirmation email is triggered through Resend', () => {
  it('sends the guest a confirmation with the booking details and their personal cancel link', async () => {
    expect((await book()).status).toBe(201);
    const row = bookingsAt(A.id as string, MONDAY, '19:00')[0] as unknown as Booking;

    const [mail] = sentTo(guest.email);
    expect(mail).toBeDefined();
    expect(mail.from).toBe(EMAIL_FROM);
    expect(mail.subject).toBe(`Booking confirmed — ${A.name}`);
    expect(mail.text).toContain(`Hi ${guest.name},`);
    expect(mail.text).toContain(`Your table at ${A.name} is confirmed.`);
    expect(mail.text).toMatch(/When: .*October 2026 at 19:00|When: .*October 26, 2026 at 19:00/);
    expect(mail.text).toContain('Party size: 4');
    expect(mail.text).toContain(`Name: ${guest.name}`);
    expect(mail.text).toContain(`Phone: ${guest.phone}`);
    expect(mail.text).toContain(`Notes: ${guest.notes}`);
    expect(mail.text).toContain(`${APP_URL}/cancel/${row.cancel_token}`);
  });

  it('the confirmation follows the language the guest booked in', async () => {
    expect((await book({ lang: 'pt' })).status).toBe(201);
    const [mail] = sentTo(guest.email);
    expect(mail.subject).toBe(`Reserva confirmada — ${A.name}`);
    expect(mail.text).toContain(`Olá ${guest.name},`);
    expect(mail.text).toContain('Pessoas: 4');
  });

  it('the owner gets a new-booking notice in the restaurant language, including the guest email', async () => {
    expect((await book()).status).toBe(201);
    const [mail] = sentTo(ownerA.email as string);
    expect(mail.subject).toMatch(new RegExp(`^New booking — ${guest.name}, .* at 19:00$`));
    expect(mail.text).toContain(`New online booking for ${A.name}:`);
    expect(mail.text).toContain(`Email: ${guest.email}`);
    expect(emailsSend).toHaveBeenCalledTimes(2); // guest + owner, nothing else
  });

  it('a restaurant without an owner row still books, and only the guest is emailed', async () => {
    db.tables.owners = db.tables.owners.filter((o) => o.restaurant_id !== A.id);
    expect((await book()).status).toBe(201);
    expect(emailsSend).toHaveBeenCalledTimes(1);
    expect(emailsSend.mock.calls[0][0].to).toBe(guest.email);
  });

  it('nothing is sent when the booking is refused', async () => {
    seedBooking({ party_size: 10 });
    expect((await book({ partySize: 1 })).status).toBe(409);
    expect((await book({ time: '19:15' })).status).toBe(400);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it('a Resend failure is logged and never fails the booking (documented design)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    emailsSend
      .mockRejectedValueOnce(new Error('resend is down'))
      .mockResolvedValueOnce({ data: null, error: { message: 'invalid from address', name: 'validation_error' } });

    const res = await book();
    expect(res.status).toBe(201);
    expect(db.tables.bookings).toHaveLength(1);
    expect(emailsSend).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([expect.stringMatching(/\[email\] send threw/), expect.stringMatching(/\[email\] send failed/)])
    );
  });

  // AUDIT.md L9: `appUrl()` falls back to the hard-coded production host when
  // NEXT_PUBLIC_APP_URL is missing, so a staging or local deployment emails
  // guests production cancel links. Correct behaviour: fail loudly instead.
  it.fails('AUDIT L9: with NEXT_PUBLIC_APP_URL unset, the cancel link must not silently point at production', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    try {
      expect((await book()).status).toBe(201);
      const [mail] = sentTo(guest.email);
      expect(mail.text).not.toContain('https://app.tablesfront.com/cancel/');
    } finally {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    }
  });
});
