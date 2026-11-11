// The stays and appointments public APIs against the real STAGING database:
// the real route handlers, the real schema of migration 0006, the real
// create_stay_reservation() / create_appointment() functions and real RLS.
// Online payment is off for these fixtures (no Stripe keys in the test run).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GET as getConfig } from '@/app/api/public/config/route';
import { GET as stayAvailability } from '@/app/api/public/stays/availability/route';
import { POST as reserveStay } from '@/app/api/public/stays/reservations/route';
import { GET as getCatalog } from '@/app/api/public/appointments/catalog/route';
import { GET as appointmentAvailability } from '@/app/api/public/appointments/availability/route';
import { POST as bookAppointment } from '@/app/api/public/appointments/route';
import {
  adminClient,
  createFixtureOwner,
  createFixtureRestaurant,
  getRequest,
  isoDateFromNow,
  ownerClient,
  postJson,
  type Fixture,
  type OwnerFixture,
} from './helpers';

let admin: SupabaseClient;

const guest = (n: number) => ({
  name: `Vertical Guest ${n}`,
  phone: '+351 910 000 00' + n,
  email: `vertical-guest-${n}@example.test`,
  lang: 'pt',
});

describe('stays: availability and reservations', () => {
  let fx: Fixture;
  let other: Fixture;
  let owner: OwnerFixture;
  let unitId = '';
  let otherUnitId = '';
  const checkIn = isoDateFromNow(20);
  const checkOut = isoDateFromNow(23);

  beforeAll(async () => {
    admin = adminClient();
    fx = await createFixtureRestaurant({ business_type: 'stays', timezone: 'UTC' } as never);
    other = await createFixtureRestaurant({ business_type: 'stays', timezone: 'UTC' } as never);
    owner = await createFixtureOwner(fx.restaurant.id, fx.run);

    const { data: unit, error } = await admin
      .from('stay_units')
      .insert({ restaurant_id: fx.restaurant.id, name: 'Sea room', max_guests: 2, base_price_cents: 10000, cleaning_fee_cents: 2000 })
      .select('id')
      .single<{ id: string }>();
    if (error || !unit) throw new Error(`could not seed unit: ${error?.message}`);
    unitId = unit.id;

    const { data: otherUnit } = await admin
      .from('stay_units')
      .insert({ restaurant_id: other.restaurant.id, name: 'Other room', base_price_cents: 5000 })
      .select('id')
      .single<{ id: string }>();
    otherUnitId = otherUnit!.id;
  });

  afterAll(async () => {
    await owner?.cleanup();
    await fx?.cleanup();
    await other?.cleanup();
  });

  const body = (n: number, overrides: Record<string, unknown> = {}) => ({
    restaurant: fx.restaurant.id,
    unit: unitId,
    checkIn,
    checkOut,
    guests: 2,
    ...guest(n),
    ...overrides,
  });

  it('config tells the widget this business sells stays', async () => {
    const res = await getConfig(getRequest('/api/public/config', { restaurant: fx.restaurant.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ businessType: 'stays', currency: 'EUR', maxGuests: 2 });
  });

  it('offers the free unit with the server-computed price', async () => {
    const res = await stayAvailability(
      getRequest('/api/public/stays/availability', { restaurant: fx.restaurant.id, checkIn, checkOut, guests: '2' })
    );
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.nights).toBe(3);
    // 3 nights × 100.00 + 20.00 cleaning
    expect(json.units).toEqual([expect.objectContaining({ id: unitId, name: 'Sea room', totalCents: 32000 })]);
  });

  it('confirms a reservation and stores it under the right business', async () => {
    const res = await reserveStay(postJson('/api/public/stays/reservations', body(1)));
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.reservation).toMatchObject({ unit: 'Sea room', checkIn, checkOut, nights: 3, totalCents: 32000, status: 'confirmed' });
    expect(json.checkoutUrl).toBeUndefined();

    const { data } = await admin
      .from('stay_reservations')
      .select('restaurant_id, unit_id, status, source, guests, total_cents, guest_lang, payment_status')
      .eq('id', json.reservation.id);
    expect(data).toEqual([
      {
        restaurant_id: fx.restaurant.id,
        unit_id: unitId,
        status: 'confirmed',
        source: 'widget',
        guests: 2,
        total_cents: 32000,
        guest_lang: 'pt',
        payment_status: 'none',
      },
    ]);
  });

  it('refuses overlapping dates and stops offering the unit', async () => {
    const clash = await reserveStay(
      postJson('/api/public/stays/reservations', body(2, { checkIn: isoDateFromNow(22), checkOut: isoDateFromNow(25) }))
    );
    expect(clash.status).toBe(409);
    expect((await clash.json()).code).toBe('DATES_TAKEN');

    const res = await stayAvailability(
      getRequest('/api/public/stays/availability', { restaurant: fx.restaurant.id, checkIn, checkOut, guests: '2' })
    );
    expect((await res.json()).units).toEqual([]);
  });

  it('lets the next guest arrive on the day the previous one leaves', async () => {
    const res = await reserveStay(
      postJson('/api/public/stays/reservations', body(3, { checkIn: checkOut, checkOut: isoDateFromNow(24) }))
    );
    expect(res.status).toBe(201);
  });

  it('of two guests racing for the same dates exactly one wins', async () => {
    const dates = { checkIn: isoDateFromNow(40), checkOut: isoDateFromNow(42) };
    const results = await Promise.all(
      [4, 5, 6, 7].map((n) => reserveStay(postJson('/api/public/stays/reservations', body(n, dates))))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);

    const { data } = await admin
      .from('stay_reservations')
      .select('id')
      .eq('unit_id', unitId)
      .eq('check_in', dates.checkIn)
      .eq('status', 'confirmed');
    expect(data).toHaveLength(1);
  });

  it("never books another business's unit", async () => {
    const res = await reserveStay(postJson('/api/public/stays/reservations', body(8, { unit: otherUnitId })));
    expect(res.status).toBe(404);
    const { data } = await admin.from('stay_reservations').select('id').eq('unit_id', otherUnitId);
    expect(data).toEqual([]);
  });

  it('the owner sees only their own reservations and units through RLS', async () => {
    await admin.from('stay_reservations').insert({
      restaurant_id: other.restaurant.id,
      unit_id: otherUnitId,
      check_in: isoDateFromNow(20),
      check_out: isoDateFromNow(22),
      guest_name: 'Foreign Guest',
      source: 'manual',
    });
    const client = await ownerClient(owner);
    const { data: units } = await client.from('stay_units').select('id');
    expect(units).toEqual([{ id: unitId }]);
    const { data: reservations } = await client.from('stay_reservations').select('restaurant_id, guest_name');
    expect(reservations!.length).toBeGreaterThanOrEqual(3);
    expect(new Set(reservations!.map((r) => r.restaurant_id))).toEqual(new Set([fx.restaurant.id]));
  });

  it('the booking function is not callable with the public key', async () => {
    const client = await ownerClient(owner);
    const { error } = await client.rpc('create_stay_reservation', {
      p_restaurant_id: other.restaurant.id,
      p_unit_id: otherUnitId,
      p_check_in: isoDateFromNow(60),
      p_check_out: isoDateFromNow(61),
      p_guests: 1,
      p_guest_name: 'RLS-HACKED',
      p_guest_phone: '0',
      p_guest_email: 'x@example.test',
      p_notes: null,
      p_source: 'widget',
      p_guest_lang: 'en',
      p_total_cents: 0,
      p_amount_due_cents: 0,
      p_currency: 'EUR',
      p_hold_minutes: 0,
    });
    expect(error?.code).toBe('42501');
  });

  it('an owner cannot move their business to another product', async () => {
    const client = await ownerClient(owner);
    const { error } = await client.from('restaurants').update({ business_type: 'restaurant' }).eq('id', fx.restaurant.id);
    expect(error?.code).toBe('42501');
    const { data } = await admin.from('restaurants').select('business_type').eq('id', fx.restaurant.id).single();
    expect(data).toEqual({ business_type: 'stays' });
  });

  it('the restaurant booking endpoints do not serve a stays business', async () => {
    const res = await appointmentAvailability(
      getRequest('/api/public/appointments/availability', {
        restaurant: fx.restaurant.id,
        service: '00000000-0000-4000-8000-000000000000',
        date: isoDateFromNow(5),
      })
    );
    expect(res.status).toBe(404);
  });
});

describe('appointments: catalog, availability and booking', () => {
  let fx: Fixture;
  let serviceId = '';
  let ruiId = '';
  let anaId = '';
  const date = isoDateFromNow(9);

  beforeAll(async () => {
    admin = adminClient();
    const hours = Object.fromEntries(
      ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '09:00', close: '18:00', closed: false }])
    );
    fx = await createFixtureRestaurant({ business_type: 'appointments', timezone: 'UTC', operating_hours: hours } as never);

    const { data: service, error } = await admin
      .from('services')
      .insert({ restaurant_id: fx.restaurant.id, name: 'Cut', category: 'Hair', duration_minutes: 30, buffer_minutes: 10, price_cents: 2500 })
      .select('id')
      .single<{ id: string }>();
    if (error || !service) throw new Error(`could not seed service: ${error?.message}`);
    serviceId = service.id;
    // A service nobody performs must stay out of the catalog.
    await admin.from('services').insert({ restaurant_id: fx.restaurant.id, name: 'Orphan', duration_minutes: 30 });

    const { data: staff } = await admin
      .from('staff')
      .insert([
        { restaurant_id: fx.restaurant.id, name: 'Rui', sort: 1 },
        { restaurant_id: fx.restaurant.id, name: 'Ana', sort: 2 },
      ])
      .select('id, name')
      .returns<{ id: string; name: string }[]>();
    ruiId = staff!.find((s) => s.name === 'Rui')!.id;
    anaId = staff!.find((s) => s.name === 'Ana')!.id;
    await admin.from('staff_services').insert([
      { restaurant_id: fx.restaurant.id, staff_id: ruiId, service_id: serviceId },
      { restaurant_id: fx.restaurant.id, staff_id: anaId, service_id: serviceId },
    ]);
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  const body = (n: number, overrides: Record<string, unknown> = {}) => ({
    restaurant: fx.restaurant.id,
    service: serviceId,
    staff: 'any',
    date,
    time: '10:00',
    ...guest(n),
    ...overrides,
  });

  const slotsFor = async (staff: string) => {
    const res = await appointmentAvailability(
      getRequest('/api/public/appointments/availability', { restaurant: fx.restaurant.id, service: serviceId, staff, date })
    );
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    return (json.slots as { time: string }[]).map((s) => s.time);
  };

  it('the catalog lists bookable services and who performs them', async () => {
    const res = await getCatalog(getRequest('/api/public/appointments/catalog', { restaurant: fx.restaurant.id }));
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(200);
    expect(json.paymentMode).toBe('none');
    expect(json.services).toEqual([
      expect.objectContaining({ id: serviceId, name: 'Cut', category: 'Hair', durationMinutes: 30, priceCents: 2500, dueNowCents: 0 }),
    ]);
    expect(json.staff.map((s: { name: string }) => s.name)).toEqual(['Rui', 'Ana']);
  });

  it('offers start times inside opening hours', async () => {
    const slots = await slotsFor('any');
    expect(slots[0]).toBe('09:00');
    expect(slots).toContain('10:00');
    expect(slots).not.toContain('18:00');
  });

  it('books with "any professional", then the second guest gets the other one', async () => {
    const first = await bookAppointment(postJson('/api/public/appointments', body(1)));
    const firstJson = await first.json();
    expect(first.status, JSON.stringify(firstJson)).toBe(201);
    expect(firstJson.appointment.status).toBe('confirmed');

    const second = await bookAppointment(postJson('/api/public/appointments', body(2)));
    expect(second.status).toBe(201);

    const { data } = await admin
      .from('appointments')
      .select('staff_id, start_time, end_time, busy_until, service_name, price_cents, status, source, guest_lang')
      .eq('restaurant_id', fx.restaurant.id)
      .eq('date', date)
      .eq('start_time', '10:00');
    expect(data).toHaveLength(2);
    expect(new Set(data!.map((a) => a.staff_id))).toEqual(new Set([ruiId, anaId]));
    expect(data![0]).toMatchObject({
      start_time: '10:00:00',
      end_time: '10:30:00',
      busy_until: '10:40:00', // 30 min + 10 min buffer
      service_name: 'Cut',
      price_cents: 2500,
      status: 'confirmed',
      source: 'widget',
      guest_lang: 'pt',
    });
  });

  it('with everyone busy the time is refused and no longer offered', async () => {
    const third = await bookAppointment(postJson('/api/public/appointments', body(3)));
    expect(third.status).toBe(409);
    expect((await third.json()).code).toBe('SLOT_TAKEN');

    const slots = await slotsFor('any');
    expect(slots).not.toContain('10:00');
    // The buffer keeps 10:30 blocked too; 10:40 is the first free start again.
    expect(slots).not.toContain('10:30');
  });

  it('a professional is never double booked by guests racing for one slot', async () => {
    const results = await Promise.all(
      [4, 5, 6, 7].map((n) =>
        bookAppointment(postJson('/api/public/appointments', body(n, { staff: ruiId, time: '14:00' })))
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const { data } = await admin
      .from('appointments')
      .select('id')
      .eq('staff_id', ruiId)
      .eq('date', date)
      .eq('start_time', '14:00');
    expect(data).toHaveLength(1);
  });

  it('time off removes a professional from that day', async () => {
    await admin.from('staff_time_off').insert({ restaurant_id: fx.restaurant.id, staff_id: anaId, date });
    expect(await slotsFor(anaId)).toEqual([]);
    expect(await slotsFor(ruiId)).toContain('16:00');
  });
});
