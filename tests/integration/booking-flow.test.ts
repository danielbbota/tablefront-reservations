// =============================================================================
// Booking flow, locked in as it behaves TODAY (2026-10-21), against STAGING.
//
// Same five promises as tests/unit/booking-flow.test.ts, but with the real
// Postgres function `create_widget_booking()`, real RLS, real Auth users and
// real PostgREST. Two throwaway restaurants (A and B), each with one owner,
// are created for the run and deleted afterwards. The `resend` package is
// mocked so nothing is ever sent, while the real email module still runs.
//
// Each test uses its own time slot on one date so tests never share covers.
//
// Tests marked `it.fails` describe the CORRECT behaviour where today's code is
// wrong, each with the AUDIT.md item. They pass while the bug exists and must
// be flipped to `it` once the fix lands (for C1/F1: once migration 0005 is
// applied to staging). Nothing in the app is changed by this file.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminClient,
  anonClient,
  createFixtureOwner,
  createFixtureRestaurant,
  getRequest,
  isoDateFromNow,
  ownerClient,
  postJson,
  type Fixture,
  type OwnerFixture,
} from './helpers';

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

let A: Fixture;
let B: Fixture;
let ownerA: OwnerFixture;
let ownerB: OwnerFixture;

const date = isoDateFromNow(6);

const guest = (tag: string) => ({
  name: `Flow Guest ${tag}`,
  phone: '+351 930 000 000',
  email: `flow-guest-${tag}@example.test`,
});

const book = (restaurantId: string, time: string, partySize: number, tag: string, extra: Record<string, unknown> = {}) =>
  postBooking(postJson('/api/public/bookings', { restaurant: restaurantId, date, time, partySize, ...guest(tag), ...extra }));

async function remaining(restaurantId: string, time: string): Promise<number | undefined> {
  const res = await getAvailability(getRequest('/api/public/availability', { restaurant: restaurantId, date }));
  expect(res.status).toBe(200);
  const { slots } = (await res.json()) as { slots: { time: string; remaining: number }[] };
  return slots.find((s) => s.time === time)?.remaining;
}

async function rowsAt(restaurantId: string, time: string) {
  const { data, error } = await adminClient()
    .from('bookings')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('date', date)
    .eq('time_slot', `${time}:00`)
    .order('created_at');
  expect(error).toBeNull();
  return data ?? [];
}

const sentTo = (to: string) => emailsSend.mock.calls.map(([args]) => args).filter((a) => a.to === to);

/** A date inside the booking window that does not exist on the calendar (e.g. 2026-11-31), or null if none falls in the window right now. */
function impossibleDateInsideHorizon(): string | null {
  const today = new Date();
  for (let k = 0; k <= 2; k++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + k, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    if (daysInMonth === 31) continue;
    const candidate = `${y}-${String(m + 1).padStart(2, '0')}-${daysInMonth === 30 ? '31' : '30'}`;
    if (candidate > isoDateFromNow(1) && candidate <= isoDateFromNow(59)) return candidate;
  }
  return null;
}

beforeAll(async () => {
  A = await createFixtureRestaurant();
  B = await createFixtureRestaurant();
  ownerA = await createFixtureOwner(A.restaurant.id, `${A.run}-a`);
  ownerB = await createFixtureOwner(B.restaurant.id, `${B.run}-b`);
});
afterAll(async () => {
  await ownerA?.cleanup();
  await ownerB?.cleanup();
  await A?.cleanup();
  await B?.cleanup();
});
beforeEach(() => emailsSend.mockClear());

// =============================================================================
// 1. Guest books a slot
// =============================================================================
describe('1. a guest books a slot with name, phone, email, date, time, party size and notes', () => {
  it('stores every field under the booked restaurant, exactly as sent, and answers 201', async () => {
    const tag = `${A.run}-fields`;
    const res = await book(A.restaurant.id, '12:00', 3, tag, { notes: '  Allergic to nuts  ', lang: 'fr' });
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), date, time: '12:00', partySize: 3, status: 'confirmed' });

    const rows = await rowsAt(A.restaurant.id, '12:00');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: booking.id,
      restaurant_id: A.restaurant.id,
      guest_name: `Flow Guest ${tag}`,
      guest_phone: '+351 930 000 000',
      guest_email: `flow-guest-${tag}@example.test`,
      party_size: 3,
      date,
      time_slot: '12:00:00',
      notes: 'Allergic to nuts',
      status: 'confirmed',
      source: 'widget',
      guest_lang: 'fr',
      table_number: null,
      service_status: null,
      reminder_sent_at: null,
    });
    expect(rows[0].cancel_token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses off-grid, past and out-of-window requests without writing anything', async () => {
    const offGrid = await book(A.restaurant.id, '12:45', 2, `${A.run}-offgrid`);
    expect(offGrid.status).toBe(400);
    const past = await postBooking(
      postJson('/api/public/bookings', { restaurant: A.restaurant.id, date: isoDateFromNow(-2), time: '12:00', partySize: 2, ...guest(`${A.run}-past`) })
    );
    expect(past.status).toBe(400);
    const far = await postBooking(
      postJson('/api/public/bookings', { restaurant: A.restaurant.id, date: isoDateFromNow(61), time: '12:00', partySize: 2, ...guest(`${A.run}-far`) })
    );
    expect(far.status).toBe(400);

    const { count } = await adminClient()
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', A.restaurant.id)
      .in('guest_name', [`Flow Guest ${A.run}-offgrid`, `Flow Guest ${A.run}-past`, `Flow Guest ${A.run}-far`]);
    expect(count).toBe(0);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  // AUDIT.md L1: the date regex and the string horizon check let an impossible
  // calendar date through to Postgres, which rejects it, so the guest gets a
  // 500. Correct behaviour: 400 before any database write is attempted.
  const impossible = impossibleDateInsideHorizon();
  (impossible ? it.fails : it.skip)(`AUDIT L1: an impossible calendar date (${impossible ?? 'none in window today'}) is refused with 400`, async () => {
    const res = await postBooking(
      postJson('/api/public/bookings', { restaurant: A.restaurant.id, date: impossible, time: '12:00', partySize: 2, ...guest(`${A.run}-l1`) })
    );
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// 2. Booking is rejected when the slot cap is reached
// =============================================================================
describe('2. a booking is rejected when the slot cap is reached', () => {
  it('the database function sells the last covers exactly once and writes nothing on refusal', async () => {
    // 12:30 capped at 5 by a date+slot rule.
    const { error } = await adminClient()
      .from('capacity_rules')
      .insert({ restaurant_id: A.restaurant.id, specific_date: date, time_slot: '12:30', max_covers: 5 });
    expect(error).toBeNull();
    expect(await remaining(A.restaurant.id, '12:30')).toBe(5);

    expect((await book(A.restaurant.id, '12:30', 3, `${A.run}-cap1`)).status).toBe(201);
    expect((await book(A.restaurant.id, '12:30', 3, `${A.run}-cap2`)).status).toBe(409); // 3 + 3 > 5
    expect((await book(A.restaurant.id, '12:30', 2, `${A.run}-cap3`)).status).toBe(201); // exactly 5
    const full = await book(A.restaurant.id, '12:30', 1, `${A.run}-cap4`);
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: 'Sorry, that time just filled up. Please pick another slot.', code: 'SLOT_FULL' });

    const rows = await rowsAt(A.restaurant.id, '12:30');
    expect(rows.map((r) => r.party_size)).toEqual([3, 2]);
    expect(await remaining(A.restaurant.id, '12:30')).toBe(0);
    expect(sentTo(`flow-guest-${A.run}-cap2@example.test`)).toHaveLength(0);
    expect(sentTo(`flow-guest-${A.run}-cap4@example.test`)).toHaveLength(0);
  });

  it('cancelling a booking frees its covers for the next guest', async () => {
    // 13:00 capped at 4.
    await adminClient().from('capacity_rules').insert({ restaurant_id: A.restaurant.id, specific_date: date, time_slot: '13:00', max_covers: 4 });
    const first = await book(A.restaurant.id, '13:00', 4, `${A.run}-free1`);
    expect(first.status).toBe(201);
    expect((await book(A.restaurant.id, '13:00', 1, `${A.run}-free2`)).status).toBe(409);

    // Cancel the way the guest cancel page / dashboard do: status -> cancelled.
    const { id } = (await first.json()).booking;
    const { error } = await adminClient().from('bookings').update({ status: 'cancelled' }).eq('id', id);
    expect(error).toBeNull();

    expect(await remaining(A.restaurant.id, '13:00')).toBe(4);
    expect((await book(A.restaurant.id, '13:00', 4, `${A.run}-free3`)).status).toBe(201);
  });

  it('a default cap of 0 closes online booking for the whole restaurant', async () => {
    const closed = await createFixtureRestaurant({ default_max_covers: 0 });
    try {
      expect(await remaining(closed.restaurant.id, '12:00')).toBe(0);
      expect((await book(closed.restaurant.id, '12:00', 1, `${closed.run}-zero`)).status).toBe(409);
    } finally {
      await closed.cleanup();
    }
  });

  // AUDIT.md M3: covers are summed per exact slot string, in the function and
  // in the availability route. 24 confirmed covers at 13:45 (manual, off the
  // 30-minute grid) leave the 13:30 slot looking empty and bookable.
  // Correct behaviour: count covers whose start falls in [slot, slot+interval).
  it.fails('AUDIT M3: off-grid confirmed covers count toward the slot window they fall into', async () => {
    const { error } = await adminClient().from('bookings').insert({
      restaurant_id: A.restaurant.id,
      guest_name: `Flow Guest ${A.run}-offgrid-manual`,
      guest_phone: '',
      guest_email: '',
      party_size: 24,
      date,
      time_slot: '13:45',
      status: 'confirmed',
      source: 'manual',
    });
    expect(error).toBeNull();
    expect(await remaining(A.restaurant.id, '13:30')).toBe(0);
    expect((await book(A.restaurant.id, '13:30', 1, `${A.run}-m3`)).status).toBe(409);
  });
});

// =============================================================================
// 3. Owner-set cap per time slot, and the manual override
// =============================================================================
describe('3. the owner-set cap per time slot is respected and the manual override works', () => {
  it('a day+slot rule caps that slot, a date+slot rule beats it, other slots keep the default', async () => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const owner = await ownerClient(ownerA);
    // Rules written under the owner's RLS session, as the dashboard would.
    const { error } = await owner.from('capacity_rules').insert([
      { restaurant_id: A.restaurant.id, day_of_week: dow, time_slot: '14:00', max_covers: 6 },
      { restaurant_id: A.restaurant.id, day_of_week: dow, time_slot: '14:30', max_covers: 6 },
      { restaurant_id: A.restaurant.id, specific_date: date, time_slot: '14:30', max_covers: 2 },
    ]);
    expect(error).toBeNull();

    expect(await remaining(A.restaurant.id, '14:00')).toBe(6);
    expect(await remaining(A.restaurant.id, '14:30')).toBe(2);
    expect(await remaining(A.restaurant.id, '15:00')).toBe(24);

    expect((await book(A.restaurant.id, '14:00', 7, `${A.run}-r1`)).status).toBe(409);
    expect((await book(A.restaurant.id, '14:00', 6, `${A.run}-r2`)).status).toBe(201);
    expect((await book(A.restaurant.id, '14:30', 3, `${A.run}-r3`)).status).toBe(409);
    expect((await book(A.restaurant.id, '14:30', 2, `${A.run}-r4`)).status).toBe(201);
    expect((await book(A.restaurant.id, '15:00', 12, `${A.run}-r5`)).status).toBe(201);
  });

  it('a per-day cap (what Settings edits) applies to every slot of that weekday', async () => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const owner = await ownerClient(ownerB);
    const { error } = await owner.from('capacity_rules').insert({ restaurant_id: B.restaurant.id, day_of_week: dow, max_covers: 3 });
    expect(error).toBeNull();

    expect(await remaining(B.restaurant.id, '12:00')).toBe(3);
    expect(await remaining(B.restaurant.id, '21:30')).toBe(3);
    expect((await book(B.restaurant.id, '12:00', 4, `${B.run}-d1`)).status).toBe(409);
    expect((await book(B.restaurant.id, '12:00', 3, `${B.run}-d2`)).status).toBe(201);

    // Removing the rule (blank cap in Settings) restores the default.
    await owner.from('capacity_rules').delete().eq('restaurant_id', B.restaurant.id).eq('day_of_week', dow).is('specific_date', null).is('time_slot', null);
    expect(await remaining(B.restaurant.id, '12:30')).toBe(24);
  });

  it('manual override: the owner can book a full slot from the dashboard; it is accepted in full and counts against the cap', async () => {
    // 15:30 capped at 4 and filled online.
    await adminClient().from('capacity_rules').insert({ restaurant_id: A.restaurant.id, specific_date: date, time_slot: '15:30', max_covers: 4 });
    expect((await book(A.restaurant.id, '15:30', 4, `${A.run}-m1`)).status).toBe(201);
    expect((await book(A.restaurant.id, '15:30', 1, `${A.run}-m2`)).status).toBe(409);

    // Exactly the insert createManualBooking() performs, under the owner's RLS session.
    const owner = await ownerClient(ownerA);
    const { data: manual, error } = await owner
      .from('bookings')
      .insert({
        restaurant_id: A.restaurant.id,
        guest_lang: 'en',
        guest_name: `Flow Guest ${A.run}-manual`,
        guest_phone: '+351 940 000 000',
        guest_email: `flow-guest-${A.run}-manual@example.test`,
        party_size: 10,
        date,
        time_slot: '15:30',
        notes: 'Regulars',
        table_number: 'T1',
        status: 'confirmed',
        source: 'manual',
      })
      .select('*')
      .single();
    expect(error).toBeNull();
    expect(manual).toMatchObject({ restaurant_id: A.restaurant.id, party_size: 10, time_slot: '15:30:00', source: 'manual', status: 'confirmed' });

    const rows = await rowsAt(A.restaurant.id, '15:30');
    expect(rows.reduce((s, r) => s + r.party_size, 0)).toBe(14); // 4 online + 10 manual, over the cap of 4
    expect(await remaining(A.restaurant.id, '15:30')).toBe(0);
    expect((await book(A.restaurant.id, '15:30', 1, `${A.run}-m3`)).status).toBe(409);
    expect(emailsSend.mock.calls.filter(([a]) => a.to.includes('-manual@'))).toHaveLength(0); // no guest email for manual bookings today
  });
});

// =============================================================================
// 4. Tenant scoping
// =============================================================================
describe('4. a booking is scoped to the correct tenant', () => {
  it("restaurant B's bookings and rules never touch restaurant A's slot, and A's owner alone is notified", async () => {
    // B: 16:00 capped at 1 and filled.
    await adminClient().from('capacity_rules').insert({ restaurant_id: B.restaurant.id, specific_date: date, time_slot: '16:00', max_covers: 1 });
    expect((await book(B.restaurant.id, '16:00', 1, `${B.run}-t1`)).status).toBe(201);
    expect((await book(B.restaurant.id, '16:00', 1, `${B.run}-t2`)).status).toBe(409);
    emailsSend.mockClear();

    const res = await book(A.restaurant.id, '16:00', 10, `${A.run}-t3`);
    expect(res.status).toBe(201);
    expect(await rowsAt(A.restaurant.id, '16:00')).toEqual([expect.objectContaining({ restaurant_id: A.restaurant.id, party_size: 10 })]);
    expect(await rowsAt(B.restaurant.id, '16:00')).toEqual([expect.objectContaining({ restaurant_id: B.restaurant.id, party_size: 1 })]);
    expect(await remaining(A.restaurant.id, '16:00')).toBe(14);
    expect(await remaining(B.restaurant.id, '16:00')).toBe(0);

    expect(sentTo(ownerA.email)).toHaveLength(1);
    expect(sentTo(ownerB.email)).toHaveLength(0);
  });

  it('an owner cannot file a manual booking under another restaurant (RLS)', async () => {
    const owner = await ownerClient(ownerA);
    const { data, error } = await owner
      .from('bookings')
      .insert({
        restaurant_id: B.restaurant.id,
        guest_name: `Flow Guest ${A.run}-cross`,
        guest_phone: '',
        guest_email: '',
        party_size: 2,
        date,
        time_slot: '16:30',
        status: 'confirmed',
        source: 'manual',
      })
      .select('id');
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe('42501');
    expect(await rowsAt(B.restaurant.id, '16:30')).toEqual([]);
  });

  it('an owner sees and edits only their own bookings', async () => {
    expect((await book(A.restaurant.id, '17:00', 2, `${A.run}-own`)).status).toBe(201);
    expect((await book(B.restaurant.id, '17:00', 2, `${B.run}-own`)).status).toBe(201);
    const owner = await ownerClient(ownerA);

    const { data: visible } = await owner.from('bookings').select('restaurant_id').eq('date', date).eq('time_slot', '17:00:00');
    expect(visible?.map((r) => r.restaurant_id)).toEqual([A.restaurant.id]);

    const { data: touched } = await owner.from('bookings').update({ notes: 'edited' }).eq('restaurant_id', B.restaurant.id).select('id');
    expect(touched ?? []).toEqual([]);
    expect((await rowsAt(B.restaurant.id, '17:00'))[0].notes).toBeNull();
  });

  // AUDIT.md C1 / F1: `create_widget_booking()` is SECURITY DEFINER and still
  // EXECUTE-able by PUBLIC, so the public anon key can insert a confirmed
  // booking into any restaurant with any cap, skipping every check in the
  // route. Correct behaviour: permission denied (42501) and no row. Flip to
  // `it` once tests/rls/proposed/0005_tenant_isolation_fixes.sql is applied.
  it.fails('AUDIT C1/F1: the booking function cannot be called with the public anon key', async () => {
    const r = await anonClient().rpc('create_widget_booking', {
      p_restaurant_id: A.restaurant.id,
      p_date: date,
      p_time_slot: '17:30',
      p_party_size: 50,
      p_guest_name: `Flow Guest ${A.run}-anon-rpc`,
      p_guest_phone: '0',
      p_guest_email: 'anon@example.test',
      p_notes: null,
      p_max_covers: 1000,
      p_guest_lang: 'en',
    });
    expect(r.error?.code).toBe('42501');
    expect(await rowsAt(A.restaurant.id, '17:30')).toEqual([]);
  });
});

// =============================================================================
// 5. Confirmation email (Resend mocked)
// =============================================================================
describe('5. a confirmation email is triggered through Resend', () => {
  it('sends the guest a confirmation carrying the stored cancel token, and the owner a notice', async () => {
    const tag = `${A.run}-mail`;
    const res = await book(A.restaurant.id, '18:00', 2, tag, { notes: 'Quiet corner', lang: 'pt' });
    expect(res.status).toBe(201);
    const [row] = await rowsAt(A.restaurant.id, '18:00');

    const [toGuest] = sentTo(`flow-guest-${tag}@example.test`);
    expect(toGuest).toBeDefined();
    expect(toGuest.from).toBe(process.env.EMAIL_FROM);
    expect(toGuest.subject).toBe(`Reserva confirmada — ${A.restaurant.name}`);
    expect(toGuest.text).toContain(`Olá Flow Guest ${tag},`);
    expect(toGuest.text).toContain('Pessoas: 2');
    expect(toGuest.text).toContain('Notas: Quiet corner');
    expect(toGuest.text).toContain(`${process.env.NEXT_PUBLIC_APP_URL}/cancel/${row.cancel_token}`);

    const [toOwner] = sentTo(ownerA.email);
    expect(toOwner).toBeDefined();
    expect(toOwner.subject).toMatch(new RegExp(`^New booking — Flow Guest ${tag}, .* at 18:00$`));
    expect(toOwner.text).toContain(`Email: flow-guest-${tag}@example.test`);
    expect(emailsSend).toHaveBeenCalledTimes(2);
  });

  it('a Resend outage never fails the booking', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    emailsSend.mockRejectedValueOnce(new Error('resend is down')).mockRejectedValueOnce(new Error('resend is down'));
    try {
      const res = await book(A.restaurant.id, '18:30', 2, `${A.run}-outage`);
      expect(res.status).toBe(201);
      expect(await rowsAt(A.restaurant.id, '18:30')).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});
