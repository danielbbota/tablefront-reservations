// Online payment, end to end but hermetic: the real public booking routes and
// the real Stripe webhook, against the real schema and SQL functions (an
// in-process Postgres behind scripts/local/supabase.mjs). Only two things are
// faked: Stripe's HTTP API and the Resend SDK. No network, no Stripe account.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { startLocalSupabase } from '../../scripts/local/supabase.mjs';

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (mail: { to: string; subject: string; text: string }) => {
        sent.push(mail);
        return { data: { id: 'email' }, error: null };
      },
    };
  },
}));

const WEBHOOK_SECRET = 'whsec_unit_test';
const realFetch = globalThis.fetch;

// --- fake Stripe -----------------------------------------------------------
type StripeCall = { path: string; account: string | null; params: URLSearchParams };
const stripe = {
  calls: [] as StripeCall[],
  failNext: false,
  sessions: 0,
};

function fakeStripe(url: string, init: RequestInit | undefined): Response {
  const path = new URL(url).pathname;
  const headers = new Headers(init?.headers);
  stripe.calls.push({
    path,
    account: headers.get('Stripe-Account'),
    params: new URLSearchParams(String(init?.body ?? '')),
  });
  if (stripe.failNext) {
    stripe.failNext = false;
    return Response.json({ error: { message: 'Your account cannot currently make charges.' } }, { status: 400 });
  }
  if (path === '/v1/checkout/sessions') {
    const id = `cs_test_${++stripe.sessions}`;
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid' });
  }
  return Response.json({ error: { message: `unexpected Stripe call ${path}` } }, { status: 404 });
}

// --- fixtures --------------------------------------------------------------
let backend: Awaited<ReturnType<typeof startLocalSupabase>>;
let admin: SupabaseClient;
let reserve: (req: NextRequest) => Promise<Response>;
let availability: (req: NextRequest) => Promise<Response>;
let bookAppointment: (req: NextRequest) => Promise<Response>;
let webhook: (req: NextRequest) => Promise<Response>;

const stays = { id: '', unit: '' };
const salon = { id: '', service: '', staff: '' };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, 'http://localhost:3100'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function stripeEvent(type: string, object: Record<string, unknown>, livemode = false) {
  const payload = JSON.stringify({ id: 'evt_1', type, livemode, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return post('/api/stripe/webhook', payload, { 'stripe-signature': `t=${t},v1=${v1}` });
}

const stayBody = (checkIn: string, checkOut: string) => ({
  restaurant: stays.id,
  unit: stays.unit,
  checkIn,
  checkOut,
  guests: 2,
  name: 'Ada Lovelace',
  phone: '+351 900 000 000',
  email: 'ada@example.test',
  lang: 'en',
});

/** A date `offset` days from today (UTC, like the fixture businesses): inside every booking horizon. */
const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const reservationById = async (id: string) =>
  (await admin.from('stay_reservations').select('*').eq('id', id).single()).data!;

beforeAll(async () => {
  backend = await startLocalSupabase({ port: 0 });
  process.env.NEXT_PUBLIC_SUPABASE_URL = backend.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = backend.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = backend.serviceRoleKey;
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3100';
  process.env.RESEND_API_KEY = 're_unit_dummy';
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return url.startsWith('https://api.stripe.com/') ? Promise.resolve(fakeStripe(url, init)) : realFetch(input, init);
  });

  admin = createClient(backend.url, backend.serviceRoleKey, { auth: { persistSession: false } });

  // A stays business taking a 30 % deposit, Stripe connected and ready.
  const s = (
    await admin
      .from('restaurants')
      .insert({ name: 'Casa Azul', slug: 'casa-azul', business_type: 'stays', timezone: 'UTC', payment_mode: 'deposit', deposit_percent: 30 })
      .select()
      .single()
  ).data!;
  stays.id = s.id;
  stays.unit = (
    await admin.from('stay_units').insert({ restaurant_id: s.id, name: 'Sea room', base_price_cents: 10000, cleaning_fee_cents: 2000 }).select().single()
  ).data!.id;
  await admin.from('payment_accounts').insert({ restaurant_id: s.id, stripe_account_id: 'acct_stays', charges_enabled: true, details_submitted: true });
  const owner = (await admin.auth.admin.createUser({ email: 'owner@casa-azul.test', password: 'unit-test-only' })).data.user!;
  await admin.from('owners').insert({ id: owner.id, restaurant_id: s.id, email: 'owner@casa-azul.test' });

  // An appointments business charging the full price.
  const hours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '09:00', close: '18:00', closed: false }]));
  const a = (
    await admin
      .from('restaurants')
      .insert({ name: 'Salon Uno', slug: 'salon-uno', business_type: 'appointments', timezone: 'UTC', payment_mode: 'full', operating_hours: hours })
      .select()
      .single()
  ).data!;
  salon.id = a.id;
  salon.service = (await admin.from('services').insert({ restaurant_id: a.id, name: 'Cut', duration_minutes: 30, price_cents: 2500 }).select().single()).data!.id;
  salon.staff = (await admin.from('staff').insert({ restaurant_id: a.id, name: 'Rui' }).select().single()).data!.id;
  await admin.from('staff_services').insert({ restaurant_id: a.id, staff_id: salon.staff, service_id: salon.service });
  await admin.from('payment_accounts').insert({ restaurant_id: a.id, stripe_account_id: 'acct_salon', charges_enabled: true, details_submitted: true });

  ({ POST: reserve } = await import('@/app/api/public/stays/reservations/route'));
  ({ GET: availability } = await import('@/app/api/public/stays/availability/route'));
  ({ POST: bookAppointment } = await import('@/app/api/public/appointments/route'));
  ({ POST: webhook } = await import('@/app/api/stripe/webhook/route'));
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await backend?.close();
});

beforeEach(() => {
  sent.length = 0;
  stripe.calls.length = 0;
});

describe('a stay with a 30 % deposit', () => {
  let reservationId = '';
  let sessionId = '';

  it('is held, not confirmed, and the guest is sent to Stripe for exactly the deposit', async () => {
    const res = await reserve(post('/api/public/stays/reservations', stayBody(day(30), day(33))));
    const body = await res.json();
    expect(res.status).toBe(201);
    // 3 nights × 100 + 20 cleaning = 320.00; 30 % = 96.00
    expect(body.reservation).toMatchObject({ totalCents: 32000, dueNowCents: 9600, status: 'pending_payment' });
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    reservationId = body.reservation.id;

    const row = await reservationById(reservationId);
    expect(row).toMatchObject({ status: 'pending_payment', payment_status: 'pending', amount_due_cents: 9600, paid_cents: 0 });
    expect(Date.parse(row.hold_expires_at)).toBeGreaterThan(Date.now() + 30 * 60_000);
    sessionId = row.stripe_session_id;
    expect(sessionId).toMatch(/^cs_test_/);

    // A direct charge on the business's own Stripe account, for the server-computed amount.
    expect(stripe.calls).toHaveLength(1);
    const call = stripe.calls[0];
    expect(call.path).toBe('/v1/checkout/sessions');
    expect(call.account).toBe('acct_stays');
    expect(call.params.get('line_items[0][price_data][unit_amount]')).toBe('9600');
    expect(call.params.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(call.params.get('metadata[kind]')).toBe('stay');
    expect(call.params.get('metadata[id]')).toBe(reservationId);
    expect(call.params.get('success_url')).toContain(`/pay/${row.cancel_token}`);

    expect(sent).toEqual([]); // nothing is confirmed to anyone before payment
  });

  it('keeps the dates for that guest while the hold is live', async () => {
    const again = await reserve(post('/api/public/stays/reservations', stayBody(day(31), day(32))));
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('DATES_TAKEN');
  });

  it('is confirmed by the signed webhook, which also sends the emails, once', async () => {
    const event = () =>
      stripeEvent('checkout.session.completed', {
        id: sessionId,
        payment_status: 'paid',
        amount_total: 9600,
        metadata: { kind: 'stay', id: reservationId },
      });

    expect((await webhook(event())).status).toBe(200);
    expect(await reservationById(reservationId)).toMatchObject({
      status: 'confirmed',
      payment_status: 'paid',
      paid_cents: 9600,
      hold_expires_at: null,
    });
    expect(sent.map((m) => m.to).sort()).toEqual(['ada@example.test', 'owner@casa-azul.test']);
    const guestMail = sent.find((m) => m.to === 'ada@example.test')!;
    expect(guestMail.subject).toContain('Reservation confirmed');
    expect(guestMail.text).toContain('Paid online: €96.00');
    expect(guestMail.text).toContain('To pay on site: €224.00');

    // Stripe retries webhooks: a replay must change nothing and email nobody.
    sent.length = 0;
    expect((await webhook(event())).status).toBe(200);
    expect(sent).toEqual([]);
    expect((await reservationById(reservationId)).paid_cents).toBe(9600);
  });

  it('an unpaid session does not confirm anything', async () => {
    const res = await reserve(post('/api/public/stays/reservations', stayBody(day(40), day(42))));
    const { reservation } = await res.json();
    const row = await reservationById(reservation.id);
    await webhook(
      stripeEvent('checkout.session.completed', {
        id: row.stripe_session_id,
        payment_status: 'unpaid',
        amount_total: 0,
        metadata: { kind: 'stay', id: reservation.id },
      })
    );
    expect((await reservationById(reservation.id)).status).toBe('pending_payment');
    expect(sent).toEqual([]);
  });

  it('an expired session releases the dates', async () => {
    const res = await reserve(post('/api/public/stays/reservations', stayBody(day(50), day(52))));
    const { reservation } = await res.json();
    const row = await reservationById(reservation.id);

    await webhook(stripeEvent('checkout.session.expired', { id: row.stripe_session_id, metadata: { kind: 'stay', id: reservation.id } }));
    expect(await reservationById(reservation.id)).toMatchObject({ status: 'cancelled', payment_status: 'none' });

    const free = await availability(
      new NextRequest(
        new URL(`/api/public/stays/availability?restaurant=${stays.id}&checkIn=${day(50)}&checkOut=${day(52)}&guests=2`, 'http://localhost:3100')
      )
    );
    const offer = (await free.json()).units[0];
    expect(offer).toMatchObject({ name: 'Sea room', totalCents: 22000, dueNowCents: 6600 });
    expect(sent).toEqual([]);
  });

  it('if Stripe refuses the session the guest gets an error and the dates are not left blocked', async () => {
    stripe.failNext = true;
    const res = await reserve(post('/api/public/stays/reservations', stayBody(day(60), day(62))));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('PAYMENT_UNAVAILABLE');

    const { data: rows } = await admin.from('stay_reservations').select('status').eq('check_in', day(60));
    expect(rows).toEqual([{ status: 'cancelled' }]);
    const retry = await reserve(post('/api/public/stays/reservations', stayBody(day(60), day(62))));
    expect(retry.status).toBe(201);
  });

  it('ignores live-mode events and events for unknown bookings', async () => {
    const res = await reserve(post('/api/public/stays/reservations', stayBody(day(70), day(71))));
    const { reservation } = await res.json();
    const row = await reservationById(reservation.id);
    const paid = { id: row.stripe_session_id, payment_status: 'paid', amount_total: 3600, metadata: { kind: 'stay', id: reservation.id } };

    const live = await webhook(stripeEvent('checkout.session.completed', paid, true));
    expect(await live.json()).toMatchObject({ ignored: 'livemode' });
    expect((await reservationById(reservation.id)).status).toBe('pending_payment');

    // A paid session id we never issued confirms nothing.
    await webhook(stripeEvent('checkout.session.completed', { ...paid, id: 'cs_test_someone_else' }));
    expect((await reservationById(reservation.id)).status).toBe('pending_payment');
  });
});

describe('when the business cannot take payments yet', () => {
  it('confirms at once without charging, and emails straight away', async () => {
    await admin.from('payment_accounts').update({ charges_enabled: false }).eq('restaurant_id', stays.id);
    try {
      const res = await reserve(post('/api/public/stays/reservations', stayBody(day(80), day(81))));
      const body = await res.json();
      expect(res.status).toBe(201);
      expect(body.checkoutUrl).toBeUndefined();
      expect(body.reservation).toMatchObject({ status: 'confirmed', dueNowCents: 0 });
      expect(stripe.calls).toEqual([]);
      expect(sent.map((m) => m.to).sort()).toEqual(['ada@example.test', 'owner@casa-azul.test']);
    } finally {
      await admin.from('payment_accounts').update({ charges_enabled: true }).eq('restaurant_id', stays.id);
    }
  });

  it('a live Stripe key switches online payment off instead of charging real cards', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_must_never_be_used';
    try {
      const res = await reserve(post('/api/public/stays/reservations', stayBody(day(90), day(91))));
      expect((await res.json()).reservation.status).toBe('confirmed');
      expect(stripe.calls).toEqual([]);
    } finally {
      process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
    }
  });
});

describe('an appointment paid in full', () => {
  it('is held for the full price, then confirmed by the webhook', async () => {
    const res = await bookAppointment(
      post('/api/public/appointments', {
        restaurant: salon.id,
        service: salon.service,
        staff: 'any',
        date: day(10),
        time: '10:00',
        name: 'Grace Hopper',
        phone: '+351 911 111 111',
        email: 'grace@example.test',
        lang: 'en',
      })
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.appointment.status).toBe('pending_payment');

    const call = stripe.calls[0];
    expect(call.account).toBe('acct_salon');
    expect(call.params.get('line_items[0][price_data][unit_amount]')).toBe('2500');
    expect(call.params.get('metadata[kind]')).toBe('appointment');
    expect(sent).toEqual([]);

    const row = (await admin.from('appointments').select('*').eq('id', body.appointment.id).single()).data!;
    // The slot is taken for everyone else while the hold lives.
    const clash = await bookAppointment(
      post('/api/public/appointments', {
        restaurant: salon.id,
        service: salon.service,
        staff: salon.staff,
        date: day(10),
        time: '10:00',
        name: 'Second',
        phone: '+351 9',
        email: 'second@example.test',
      })
    );
    expect(clash.status).toBe(409);

    await webhook(
      stripeEvent('checkout.session.completed', {
        id: row.stripe_session_id,
        payment_status: 'paid',
        amount_total: 2500,
        metadata: { kind: 'appointment', id: row.id },
      })
    );
    const confirmed = (await admin.from('appointments').select('*').eq('id', row.id).single()).data!;
    expect(confirmed).toMatchObject({ status: 'confirmed', payment_status: 'paid', paid_cents: 2500 });
    expect(sent.map((m) => m.to)).toContain('grace@example.test');
  });
});
