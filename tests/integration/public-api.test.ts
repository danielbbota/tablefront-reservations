// =============================================================================
// Integration: the public widget API against STAGING.
//
// Calls the real route handlers (GET /api/public/config, GET /api/public/
// availability, POST /api/public/bookings) with a service-role client pointed
// at the staging project. A throwaway restaurant is created for the run and
// deleted afterwards. Email is mocked so nothing is ever sent.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PARTY_SIZE } from '@/lib/types';
import { adminClient, createFixtureRestaurant, getRequest, isoDateFromNow, postJson, type Fixture } from './helpers';

const sendGuestConfirmation = vi.fn(async () => {});
const sendOwnerNotification = vi.fn(async () => {});
vi.mock('@/lib/email', () => ({
  sendGuestConfirmation,
  sendOwnerNotification,
  sendGuestCancellation: vi.fn(async () => {}),
}));

const { GET: getConfig } = await import('@/app/api/public/config/route');
const { GET: getAvailability } = await import('@/app/api/public/availability/route');
const { POST: postBooking } = await import('@/app/api/public/bookings/route');

let fx: Fixture;
const date = isoDateFromNow(5);
const guest = (tag: string) => ({
  name: `Int Guest ${tag}`,
  phone: '+351 910 000 000',
  email: `int-guest-${tag}@example.test`,
});

beforeAll(async () => {
  fx = await createFixtureRestaurant();
});
afterAll(async () => {
  await fx?.cleanup();
});

describe('GET /api/public/config', () => {
  it('returns the widget bootstrap for an existing restaurant', async () => {
    const res = await getConfig(getRequest('/api/public/config', { restaurant: fx.restaurant.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      restaurant: { id: fx.restaurant.id, name: fx.restaurant.name },
      businessType: 'restaurant',
      language: 'en',
      currency: 'EUR',
      maxPartySize: MAX_PARTY_SIZE,
      horizonDays: 60,
    });
  });
  it('404s for an unknown restaurant', async () => {
    const res = await getConfig(getRequest('/api/public/config', { restaurant: '00000000-0000-0000-0000-000000000000' }));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/public/availability', () => {
  it('lists every slot of an open day with the full default cap', async () => {
    const res = await getAvailability(getRequest('/api/public/availability', { restaurant: fx.restaurant.id, date }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restaurant).toEqual({ id: fx.restaurant.id, name: fx.restaurant.name });
    expect(body.date).toBe(date);
    // 12:00 .. 21:30 every 30 min = 20 slots
    expect(body.slots.map((s: { time: string }) => s.time)).toHaveLength(20);
    expect(body.slots[0]).toEqual({ time: '12:00', remaining: 24 });
    expect(body.slots.at(-1)).toEqual({ time: '21:30', remaining: 24 });
  });
  it('rejects a date beyond the booking horizon', async () => {
    const res = await getAvailability(
      getRequest('/api/public/availability', { restaurant: fx.restaurant.id, date: isoDateFromNow(61 + 2) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/beyond the booking window/);
  });
  it('404s for an unknown restaurant', async () => {
    const res = await getAvailability(
      getRequest('/api/public/availability', { restaurant: '00000000-0000-0000-0000-000000000000', date })
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/public/bookings', () => {
  it('creates a confirmed widget booking and reduces availability for that slot', async () => {
    const res = await postBooking(
      postJson('/api/public/bookings', {
        restaurant: fx.restaurant.id,
        date,
        time: '19:00',
        partySize: 3,
        ...guest(`${fx.run}-a`),
        notes: 'window seat',
        lang: 'pt',
      })
    );
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking).toMatchObject({ date, time: '19:00', partySize: 3, status: 'confirmed' });
    expect(booking.id).toMatch(/^[0-9a-f-]{36}$/);

    // Stored exactly as sent, scoped to the fixture restaurant.
    const { data: row } = await adminClient().from('bookings').select('*').eq('id', booking.id).single();
    expect(row).toMatchObject({
      restaurant_id: fx.restaurant.id,
      guest_name: `Int Guest ${fx.run}-a`,
      party_size: 3,
      time_slot: '19:00:00',
      source: 'widget',
      status: 'confirmed',
      guest_lang: 'pt',
      notes: 'window seat',
    });
    expect(row?.cancel_token).toBeTruthy();

    // Notifications were attempted (and mocked), never sent for real.
    expect(sendGuestConfirmation).toHaveBeenCalledTimes(1);

    const avail = await getAvailability(getRequest('/api/public/availability', { restaurant: fx.restaurant.id, date }));
    const slots: { time: string; remaining: number }[] = (await avail.json()).slots;
    expect(slots.find((s) => s.time === '19:00')?.remaining).toBe(21);
    expect(slots.find((s) => s.time === '19:30')?.remaining).toBe(24);
  });

  it('rejects a time that is not a slot for that day', async () => {
    const res = await postBooking(
      postJson('/api/public/bookings', {
        restaurant: fx.restaurant.id,
        date,
        time: '19:15',
        partySize: 2,
        ...guest(`${fx.run}-b`),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not available for booking/);
  });

  it('rejects a date outside the booking window', async () => {
    const res = await postBooking(
      postJson('/api/public/bookings', {
        restaurant: fx.restaurant.id,
        date: isoDateFromNow(90),
        time: '19:00',
        partySize: 2,
        ...guest(`${fx.run}-c`),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not bookable/);
  });

  it('404s for an unknown restaurant', async () => {
    const res = await postBooking(
      postJson('/api/public/bookings', {
        restaurant: '00000000-0000-0000-0000-000000000000',
        date,
        time: '19:00',
        partySize: 2,
        ...guest(`${fx.run}-d`),
      })
    );
    expect(res.status).toBe(404);
  });

  it('enforces the online cover cap atomically (SLOT_FULL) and honours a capacity rule', async () => {
    // Cap the 20:00 slot at 10 covers via a date+slot rule (most specific).
    const supabase = adminClient();
    const { error } = await supabase.from('capacity_rules').insert({
      restaurant_id: fx.restaurant.id,
      specific_date: date,
      time_slot: '20:00',
      max_covers: 10,
    });
    expect(error).toBeNull();

    const book = (partySize: number, tag: string) =>
      postBooking(postJson('/api/public/bookings', { restaurant: fx.restaurant.id, date, time: '20:00', partySize, ...guest(tag) }));

    expect((await book(6, `${fx.run}-cap1`)).status).toBe(201);
    expect((await book(4, `${fx.run}-cap2`)).status).toBe(201); // exactly at the cap

    const full = await book(1, `${fx.run}-cap3`);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'SLOT_FULL' });

    const avail = await getAvailability(getRequest('/api/public/availability', { restaurant: fx.restaurant.id, date }));
    const slots: { time: string; remaining: number }[] = (await avail.json()).slots;
    expect(slots.find((s) => s.time === '20:00')?.remaining).toBe(0);

    // Only the two accepted bookings exist for that slot.
    const { count } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', fx.restaurant.id)
      .eq('date', date)
      .eq('time_slot', '20:00:00');
    expect(count).toBe(2);
  });

  it('serialises concurrent bookings for the last covers of a slot', async () => {
    // 21:00 has the default cap of 24. Fire 5 x 6 covers at once: exactly 4 may win.
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        postBooking(
          postJson('/api/public/bookings', {
            restaurant: fx.restaurant.id,
            date,
            time: '21:00',
            partySize: 6,
            ...guest(`${fx.run}-race${i}`),
          })
        )
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 409]);

    const { data } = await adminClient()
      .from('bookings')
      .select('party_size')
      .eq('restaurant_id', fx.restaurant.id)
      .eq('date', date)
      .eq('time_slot', '21:00:00')
      .eq('status', 'confirmed');
    expect((data ?? []).reduce((s, b) => s + b.party_size, 0)).toBe(24);
  });
});

describe('tenant scoping of the service-role paths', () => {
  it('availability for restaurant A ignores bookings of restaurant B on the same date/slot', async () => {
    const other = await createFixtureRestaurant();
    try {
      const res = await postBooking(
        postJson('/api/public/bookings', {
          restaurant: other.restaurant.id,
          date,
          time: '12:00',
          partySize: 12,
          ...guest(`${other.run}-other`),
        })
      );
      expect(res.status).toBe(201);

      const a = await getAvailability(getRequest('/api/public/availability', { restaurant: fx.restaurant.id, date }));
      const slotsA: { time: string; remaining: number }[] = (await a.json()).slots;
      expect(slotsA.find((s) => s.time === '12:00')?.remaining).toBe(24);

      const b = await getAvailability(getRequest('/api/public/availability', { restaurant: other.restaurant.id, date }));
      const slotsB: { time: string; remaining: number }[] = (await b.json()).slots;
      expect(slotsB.find((s) => s.time === '12:00')?.remaining).toBe(12);
    } finally {
      await other.cleanup();
    }
  });
});
