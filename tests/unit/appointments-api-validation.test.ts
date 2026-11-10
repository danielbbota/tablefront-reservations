// The public appointments API, exercised by calling the route handlers
// directly.
//
// Part 1: request validation. The Supabase client is mocked to throw, which
// proves invalid input is rejected BEFORE any database access.
// Part 2: the booking flow against a tiny in-memory stand-in for the tables
// the routes read, with create_appointment() scripted per test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const refuseDatabase = () => {
  throw new Error('database must not be touched for invalid input');
};
const createAdminClient = vi.fn<() => unknown>(refuseDatabase);
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));

const sendAppointmentConfirmation = vi.fn(async () => {});
const sendAppointmentOwnerNotification = vi.fn(async () => {});
vi.mock('@/lib/appointments/email', () => ({
  sendAppointmentConfirmation,
  sendAppointmentOwnerNotification,
}));

type Setup = { mode: 'deposit' | 'full'; depositPercent: number; account: { stripe_account_id: string } };
const getPaymentSetup = vi.fn<() => Promise<Setup | null>>(async () => null);
const startCheckout = vi.fn(async () => 'https://checkout.stripe.test/session');
vi.mock('@/lib/payments/checkout', () => ({
  getPaymentSetup,
  startCheckout,
  paymentTerms: (totalCents: number, setup: Setup | null) =>
    setup && totalCents > 0
      ? { amountDueCents: Math.ceil((totalCents * setup.depositPercent) / 100), holdMinutes: 35 }
      : { amountDueCents: 0, holdMinutes: 0 },
}));

const { GET: catalog, OPTIONS: catalogOptions } = await import('@/app/api/public/appointments/catalog/route');
const { GET: availability, OPTIONS: availabilityOptions } = await import(
  '@/app/api/public/appointments/availability/route'
);
const { POST: book, OPTIONS: bookOptions } = await import('@/app/api/public/appointments/route');

const base = 'http://localhost:3100';
const get = (path: string) => new NextRequest(new URL(path, base));
const post = (body: unknown) =>
  new NextRequest(new URL('/api/public/appointments', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const BUSINESS = '00000000-0000-4000-8000-000000000001';
const SERVICE = '00000000-0000-4000-8000-0000000000a1';
const ANA = '00000000-0000-4000-8000-0000000000b1';
const RUI = '00000000-0000-4000-8000-0000000000b2';

// Frozen clock: Wednesday 2026-10-21 10:00 UTC; the business runs on UTC.
const TODAY = '2026-10-21';
const TOMORROW = '2026-10-22';

const valid = {
  restaurant: BUSINESS,
  service: SERVICE,
  staff: 'any',
  date: TOMORROW,
  time: '10:00',
  name: 'Ada',
  phone: '+351 900 000 000',
  email: 'ada@example.test',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
  createAdminClient.mockReset();
  createAdminClient.mockImplementation(refuseDatabase);
  getPaymentSetup.mockReset();
  getPaymentSetup.mockResolvedValue(null);
  startCheckout.mockClear();
  sendAppointmentConfirmation.mockClear();
  sendAppointmentOwnerNotification.mockClear();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Part 1 — validation
// ---------------------------------------------------------------------------

describe('CORS preflight', () => {
  it.each([
    ['catalog', catalogOptions],
    ['availability', availabilityOptions],
    ['booking', bookOptions],
  ])('%s is CORS-open', async (_label, options) => {
    const res = await options();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('GET /api/public/appointments/catalog validation', () => {
  it('rejects a missing business id with 400 before touching the database', async () => {
    const res = await catalog(get('/api/public/appointments/catalog'));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/public/appointments/availability validation', () => {
  const path = (params: Record<string, string>) =>
    `/api/public/appointments/availability?${new URLSearchParams(params)}`;

  it.each<[string, Record<string, string>]>([
    ['missing everything', {}],
    ['missing restaurant', { service: SERVICE, date: TOMORROW }],
    ['missing service', { restaurant: BUSINESS, date: TOMORROW }],
    ['service is not a uuid', { restaurant: BUSINESS, service: 'haircut', date: TOMORROW }],
    ['missing date', { restaurant: BUSINESS, service: SERVICE }],
    ['malformed date', { restaurant: BUSINESS, service: SERVICE, date: '22/10/2026' }],
    ['impossible date', { restaurant: BUSINESS, service: SERVICE, date: '2026-11-31' }],
    ['staff is neither "any" nor a uuid', { restaurant: BUSINESS, service: SERVICE, date: TOMORROW, staff: 'rui' }],
  ])('rejects %s with 400 before touching the database', async (_label, params) => {
    const res = await availability(get(path(params)));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('valid input reaches for the database', async () => {
    await expect(
      availability(get(path({ restaurant: BUSINESS, service: SERVICE, date: TOMORROW, staff: ANA })))
    ).rejects.toThrow(/database must not be touched/);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/public/appointments validation', () => {
  it('rejects a non-JSON body', async () => {
    const res = await book(post('{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['missing restaurant', { ...valid, restaurant: '' }, /Missing restaurant/],
    ['missing service', { ...valid, service: undefined }, /Invalid service/],
    ['service is not a uuid', { ...valid, service: 'haircut' }, /Invalid service/],
    ['staff is not a uuid', { ...valid, staff: 'rui' }, /Invalid professional/],
    ['bad date', { ...valid, date: '2026-10-2' }, /Invalid date/],
    ['impossible date', { ...valid, date: '2026-11-31' }, /Invalid date/],
    ['bad time', { ...valid, time: '10am' }, /Invalid time/],
    ['hour 24', { ...valid, time: '24:00' }, /Invalid time/],
    ['minute 60', { ...valid, time: '10:60' }, /Invalid time/],
    ['empty name', { ...valid, name: '   ' }, /Name is required/],
    ['name too long', { ...valid, name: 'x'.repeat(121) }, /Name is required/],
    ['empty phone', { ...valid, phone: '' }, /Phone is required/],
    ['phone too long', { ...valid, phone: '9'.repeat(41) }, /Phone is required/],
    ['invalid email', { ...valid, email: 'not-an-email' }, /valid email/],
    ['email with spaces', { ...valid, email: 'a b@example.test' }, /valid email/],
  ])('rejects %s with 400 before touching the database', async (_label, body, message) => {
    const res = await book(post(body));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).error).toMatch(message);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('valid input reaches for the database', async () => {
    await expect(book(post(valid))).rejects.toThrow(/database must not be touched/);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — booking flow against an in-memory stand-in
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type RpcResult = { data: Row | null; error: { message: string } | null };

/** The slice of the PostgREST builder these routes use: equality filters, then await / single. */
class Query {
  constructor(private rows: Row[]) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  returns() {
    return this;
  }
  limit(n: number) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  eq(column: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[column] === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.rows = this.rows.filter((r) => r[column] !== value);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }
  single() {
    return Promise.resolve(
      this.rows.length === 1
        ? { data: this.rows[0], error: null }
        : { data: null, error: { message: 'not exactly one row' } }
    );
  }
  then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}

const hours = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '09:00', close: '12:00', closed: false }])
);

function seed() {
  return {
    restaurants: [
      {
        id: BUSINESS,
        name: 'Barbearia Teste',
        timezone: 'UTC',
        language: 'pt',
        business_type: 'appointments',
        currency: 'EUR',
        slot_interval_minutes: 30,
        operating_hours: hours,
      },
    ] as Row[],
    services: [
      {
        id: SERVICE,
        restaurant_id: BUSINESS,
        name: 'Corte',
        category: 'Cabelo',
        description: null,
        duration_minutes: 30,
        buffer_minutes: 0,
        price_cents: 1500,
        active: true,
        sort: 0,
      },
    ] as Row[],
    staff: [
      { id: ANA, restaurant_id: BUSINESS, name: 'Ana', title: null, working_hours: null, active: true, sort: 0 },
      { id: RUI, restaurant_id: BUSINESS, name: 'Rui', title: 'Barbeiro', working_hours: null, active: true, sort: 1 },
    ] as Row[],
    staff_services: [
      { staff_id: ANA, service_id: SERVICE, restaurant_id: BUSINESS },
      { staff_id: RUI, service_id: SERVICE, restaurant_id: BUSINESS },
    ] as Row[],
    appointments: [] as Row[],
    staff_time_off: [] as Row[],
    owners: [{ restaurant_id: BUSINESS, email: 'owner@example.test' }] as Row[],
  };
}

let db: ReturnType<typeof seed>;
let rpcCalls: { name: string; args: Row }[];
let rpc: (args: Row) => RpcResult;

/** What create_appointment() returns on success. */
const created = (args: Row): RpcResult => ({
  data: {
    id: 'appt-1',
    restaurant_id: args.p_restaurant_id,
    staff_id: args.p_staff_id,
    service_id: args.p_service_id,
    date: args.p_date,
    start_time: `${args.p_start_time}:00`,
    end_time: `${args.p_end_time}:00`,
    busy_until: `${args.p_busy_until}:00`,
    service_name: args.p_service_name,
    duration_minutes: args.p_duration_minutes,
    price_cents: args.p_price_cents,
    guest_name: args.p_guest_name,
    guest_email: args.p_guest_email,
    guest_lang: args.p_guest_lang,
    status: Number(args.p_hold_minutes) > 0 ? 'pending_payment' : 'confirmed',
    cancel_token: 'token-1',
    paid_cents: 0,
  },
  error: null,
});

function useFakeDatabase() {
  db = seed();
  rpcCalls = [];
  rpc = created;
  createAdminClient.mockImplementation(() => ({
    from: (table: string) => new Query([...(db[table as keyof typeof db] ?? [])]),
    rpc: (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      return { single: () => Promise.resolve(rpc(args)) };
    },
  }));
}

const liveAppt = (staffId: string, start: string, end: string, date = TOMORROW): Row => ({
  id: `existing-${staffId}-${start}`,
  restaurant_id: BUSINESS,
  staff_id: staffId,
  date,
  start_time: `${start}:00`,
  end_time: `${end}:00`,
  busy_until: `${end}:00`,
  status: 'confirmed',
  hold_expires_at: null,
});

describe('GET /api/public/appointments/catalog', () => {
  beforeEach(useFakeDatabase);

  it('lists bookable services and the professionals who perform them', async () => {
    db.services.push(
      { ...db.services[0], id: 'svc-off', name: 'Inativo', active: false },
      { ...db.services[0], id: 'svc-nobody', name: 'Sem equipa' }
    );
    const res = await catalog(get(`/api/public/appointments/catalog?restaurant=${BUSINESS}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currency).toBe('EUR');
    expect(body.paymentMode).toBe('none');
    expect(body.services).toEqual([
      {
        id: SERVICE,
        name: 'Corte',
        category: 'Cabelo',
        description: null,
        durationMinutes: 30,
        priceCents: 1500,
        dueNowCents: 0,
      },
    ]);
    expect(body.staff).toEqual([
      { id: ANA, name: 'Ana', title: null, serviceIds: [SERVICE] },
      { id: RUI, name: 'Rui', title: 'Barbeiro', serviceIds: [SERVICE] },
    ]);
  });

  it('shows what is due online when the business takes a deposit', async () => {
    getPaymentSetup.mockResolvedValue({ mode: 'deposit', depositPercent: 30, account: { stripe_account_id: 'acct_1' } });
    const body = await (await catalog(get(`/api/public/appointments/catalog?restaurant=${BUSINESS}`))).json();
    expect(body.paymentMode).toBe('deposit');
    expect(body.services[0].dueNowCents).toBe(450);
  });

  it('404s for a business of another product', async () => {
    db.restaurants[0].business_type = 'restaurant';
    const res = await catalog(get(`/api/public/appointments/catalog?restaurant=${BUSINESS}`));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/public/appointments/availability', () => {
  beforeEach(useFakeDatabase);
  const path = (params: Record<string, string>) =>
    `/api/public/appointments/availability?${new URLSearchParams({ restaurant: BUSINESS, service: SERVICE, ...params })}`;

  it('returns the union of free starts for "any professional"', async () => {
    db.appointments.push(liveAppt(ANA, '09:00', '09:30'), liveAppt(ANA, '10:00', '10:30'), liveAppt(RUI, '10:00', '10:30'));
    const res = await availability(get(path({ date: TOMORROW })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots.map((s: { time: string }) => s.time)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('narrows to one professional', async () => {
    db.appointments.push(liveAppt(ANA, '09:00', '09:30'));
    const body = await (await availability(get(path({ date: TOMORROW, staff: ANA })))).json();
    expect(body.slots.map((s: { time: string }) => s.time)).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('today only shows times that are still ahead in the business timezone', async () => {
    const body = await (await availability(get(path({ date: TODAY })))).json();
    expect(body.slots.map((s: { time: string }) => s.time)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('a past date has no slots; a date beyond the horizon is refused', async () => {
    const past = await availability(get(path({ date: '2026-10-20' })));
    expect((await past.json()).slots).toEqual([]);
    const far = await availability(get(path({ date: '2027-02-01' })));
    expect(far.status).toBe(400);
  });

  it('404s for an unknown or inactive service and for another product', async () => {
    db.services[0].active = false;
    expect((await availability(get(path({ date: TOMORROW })))).status).toBe(404);
    db.services[0].active = true;
    db.restaurants[0].business_type = 'stays';
    expect((await availability(get(path({ date: TOMORROW })))).status).toBe(404);
  });
});

describe('POST /api/public/appointments', () => {
  beforeEach(useFakeDatabase);

  it('books the least busy professional for "any" and emails guest and owner', async () => {
    db.appointments.push(liveAppt(ANA, '09:00', '09:30'));
    const res = await book(post({ ...valid, notes: '  Fade  ', lang: 'fr' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.checkoutUrl).toBeUndefined();
    expect(body.appointment).toMatchObject({
      date: TOMORROW,
      time: '10:00',
      endTime: '10:30',
      serviceName: 'Corte',
      staffName: 'Rui',
      priceCents: 1500,
      status: 'confirmed',
    });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('create_appointment');
    expect(rpcCalls[0].args).toEqual({
      p_restaurant_id: BUSINESS,
      p_service_id: SERVICE,
      p_staff_id: RUI, // Ana already has an appointment that day
      p_date: TOMORROW,
      p_start_time: '10:00',
      p_end_time: '10:30',
      p_busy_until: '10:30',
      p_service_name: 'Corte',
      p_duration_minutes: 30,
      p_price_cents: 1500,
      p_guest_name: 'Ada',
      p_guest_phone: '+351 900 000 000',
      p_guest_email: 'ada@example.test',
      p_notes: 'Fade',
      p_source: 'widget',
      p_guest_lang: 'fr',
      p_amount_due_cents: 0,
      p_currency: 'EUR',
      p_hold_minutes: 0,
    });

    expect(sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(sendAppointmentConfirmation.mock.calls[0]).toHaveLength(3);
    expect(sendAppointmentOwnerNotification).toHaveBeenCalledTimes(1);
    const ownerCall = sendAppointmentOwnerNotification.mock.calls[0] as unknown[];
    expect(ownerCall[2]).toBe('owner@example.test');
    expect(ownerCall[3]).toBe('Rui');
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it('falls back to the business language when the guest sends none', async () => {
    await book(post(valid));
    expect(rpcCalls[0].args.p_guest_lang).toBe('pt');
  });

  it('tries the next professional when the first was taken in the meantime', async () => {
    rpc = (args) =>
      args.p_staff_id === ANA ? { data: null, error: { message: 'SLOT_TAKEN' } } : created(args);
    const res = await book(post(valid));
    expect(res.status).toBe(201);
    expect(rpcCalls.map((c) => c.args.p_staff_id)).toEqual([ANA, RUI]);
    expect((await res.json()).appointment.staffName).toBe('Rui');
  });

  it('answers 409 SLOT_TAKEN when everyone was taken in the meantime', async () => {
    rpc = () => ({ data: null, error: { message: 'SLOT_TAKEN' } });
    const res = await book(post(valid));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SLOT_TAKEN');
    expect(rpcCalls).toHaveLength(2);
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it('answers 409 without calling the database function when the time is not on offer', async () => {
    db.appointments.push(liveAppt(ANA, '10:00', '10:30'));
    const taken = await book(post({ ...valid, staff: ANA }));
    expect(taken.status).toBe(409);
    expect((await taken.json()).code).toBe('SLOT_TAKEN');
    const offGrid = await book(post({ ...valid, time: '10:10' }));
    expect(offGrid.status).toBe(409);
    const afterHours = await book(post({ ...valid, time: '12:00' }));
    expect(afterHours.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('books the requested professional only', async () => {
    const res = await book(post({ ...valid, staff: ANA }));
    expect(res.status).toBe(201);
    expect(rpcCalls.map((c) => c.args.p_staff_id)).toEqual([ANA]);
  });

  it('refuses a professional who does not perform the service', async () => {
    db.staff_services = db.staff_services.filter((l) => l.staff_id !== RUI);
    const res = await book(post({ ...valid, staff: RUI }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses past dates, times already gone today and dates beyond the horizon', async () => {
    expect((await book(post({ ...valid, date: '2026-10-20' }))).status).toBe(400);
    expect((await book(post({ ...valid, date: '2027-02-01' }))).status).toBe(400);
    // 10:00 today is "now": no longer bookable.
    expect((await book(post({ ...valid, date: TODAY, time: '10:00' }))).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('404s for another product, an unknown business and an inactive service', async () => {
    db.services[0].active = false;
    expect((await book(post(valid))).status).toBe(404);
    db.services[0].active = true;
    db.restaurants[0].business_type = 'restaurant';
    expect((await book(post(valid))).status).toBe(404);
    db.restaurants = [];
    expect((await book(post(valid))).status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it('reports a database failure as 500, not as a full slot', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc = () => ({ data: null, error: { message: 'connection reset' } });
    const res = await book(post(valid));
    expect(res.status).toBe(500);
    expect(rpcCalls).toHaveLength(1);
    quiet.mockRestore();
  });

  it('holds the slot and returns the checkout URL when a deposit is due; no emails yet', async () => {
    getPaymentSetup.mockResolvedValue({ mode: 'deposit', depositPercent: 30, account: { stripe_account_id: 'acct_1' } });
    const res = await book(post(valid));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.checkoutUrl).toBe('https://checkout.stripe.test/session');
    expect(body.appointment.status).toBe('pending_payment');
    expect(rpcCalls[0].args).toMatchObject({ p_amount_due_cents: 450, p_hold_minutes: 35 });

    expect(startCheckout).toHaveBeenCalledTimes(1);
    const [, , request, appUrl] = startCheckout.mock.calls[0] as unknown as [unknown, unknown, Row, string];
    expect(request).toMatchObject({
      kind: 'appointment',
      id: 'appt-1',
      cancelToken: 'token-1',
      amountCents: 450,
      currency: 'EUR',
      email: 'ada@example.test',
      lang: 'pt',
    });
    expect(typeof appUrl).toBe('string');
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
    expect(sendAppointmentOwnerNotification).not.toHaveBeenCalled();
  });

  it('answers 502 when the payment page cannot be created', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPaymentSetup.mockResolvedValue({ mode: 'full', depositPercent: 100, account: { stripe_account_id: 'acct_1' } });
    startCheckout.mockRejectedValueOnce(new Error('stripe down'));
    const res = await book(post(valid));
    expect(res.status).toBe(502);
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('a free service is never sent to payment', async () => {
    db.services[0].price_cents = 0;
    getPaymentSetup.mockResolvedValue({ mode: 'full', depositPercent: 100, account: { stripe_account_id: 'acct_1' } });
    const res = await book(post(valid));
    expect((await res.json()).checkoutUrl).toBeUndefined();
    expect(rpcCalls[0].args.p_hold_minutes).toBe(0);
    expect(startCheckout).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });
});
