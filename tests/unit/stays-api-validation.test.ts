// Request validation of the public stays API and the Stripe webhook, called
// directly. The Supabase client is mocked to prove invalid input is rejected
// BEFORE any database access.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { checkStayDates } from '@/lib/stays/request';
import { STAY_HORIZON_DAYS, STAY_MAX_NIGHTS } from '@/lib/types';

const createAdminClient = vi.fn(() => {
  throw new Error('database must not be touched for invalid input');
});
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));
vi.mock('@/lib/stays/email', () => ({
  sendStayConfirmation: vi.fn(),
  sendStayOwnerNotification: vi.fn(),
}));
vi.mock('@/lib/payments/notify', () => ({ notifyConfirmed: vi.fn() }));

const { GET: availability, OPTIONS } = await import('@/app/api/public/stays/availability/route');
const { POST: reserve } = await import('@/app/api/public/stays/reservations/route');
const { GET: ical } = await import('@/app/api/public/ical/[token]/route');
const { POST: webhook } = await import('@/app/api/stripe/webhook/route');

const base = 'http://localhost:3100';
const get = (path: string) => new NextRequest(new URL(path, base));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = {
  restaurant: '00000000-0000-0000-0000-000000000001',
  unit: '00000000-0000-0000-0000-000000000002',
  checkIn: '2030-07-12',
  checkOut: '2030-07-15',
  guests: 2,
  name: 'Ada',
  phone: '+351 900 000 000',
  email: 'ada@example.test',
};

beforeEach(() => {
  createAdminClient.mockClear();
});

describe('checkStayDates (business timezone)', () => {
  const business = { timezone: 'Europe/Lisbon' };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-07-10T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('accepts a stay starting today and counts its nights', () => {
    expect(checkStayDates(business, '2030-07-10', '2030-07-13')).toEqual({ ok: true, nights: 3 });
  });
  it.each<[string, unknown, unknown, string]>([
    ['missing dates', undefined, undefined, 'INVALID_DATES'],
    ['an impossible date', '2030-02-30', '2030-03-02', 'INVALID_DATES'],
    ['departure on the arrival day', '2030-07-12', '2030-07-12', 'INVALID_DATES'],
    ['departure before arrival', '2030-07-12', '2030-07-11', 'INVALID_DATES'],
    ['arrival yesterday', '2030-07-09', '2030-07-12', 'PAST'],
    ['arrival beyond the horizon', '2032-07-10', '2032-07-12', 'TOO_FAR'],
    ['a stay longer than the maximum', '2030-08-01', '2030-10-15', 'TOO_LONG'],
  ])('refuses %s', (_label, checkIn, checkOut, code) => {
    expect(checkStayDates(business, checkIn, checkOut)).toMatchObject({ ok: false, code });
  });
  it('"today" follows the business, not the server: 23:30 UTC is already tomorrow in Lisbon in summer', () => {
    vi.setSystemTime(new Date('2030-07-10T23:30:00Z'));
    expect(checkStayDates(business, '2030-07-10', '2030-07-12')).toMatchObject({ ok: false, code: 'PAST' });
    expect(checkStayDates({ timezone: 'UTC' }, '2030-07-10', '2030-07-12')).toMatchObject({ ok: true });
  });
  it('limits are the documented ones', () => {
    expect(STAY_MAX_NIGHTS).toBe(60);
    expect(STAY_HORIZON_DAYS).toBeGreaterThanOrEqual(365);
  });
});

describe('GET /api/public/stays/availability', () => {
  it('OPTIONS preflight is CORS-open', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it.each([
    ['missing business', '/api/public/stays/availability?checkIn=2030-07-12&checkOut=2030-07-15'],
    ['zero guests', '/api/public/stays/availability?restaurant=abc&checkIn=2030-07-12&checkOut=2030-07-15&guests=0'],
    ['too many guests', '/api/public/stays/availability?restaurant=abc&checkIn=2030-07-12&checkOut=2030-07-15&guests=31'],
    ['fractional guests', '/api/public/stays/availability?restaurant=abc&checkIn=2030-07-12&checkOut=2030-07-15&guests=1.5'],
  ])('rejects %s with 400 before touching the database', async (_label, path) => {
    const res = await availability(get(path));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/public/stays/reservations validation', () => {
  it('rejects a non-JSON body', async () => {
    const res = await reserve(post('/api/public/stays/reservations', '{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['missing business', { ...valid, restaurant: '' }, /Missing restaurant/],
    ['unit that is not an id', { ...valid, unit: 'room-1' }, /Missing unit/],
    ['zero guests', { ...valid, guests: 0 }, /guests/],
    ['fractional guests', { ...valid, guests: 2.5 }, /guests/],
    ['empty name', { ...valid, name: '  ' }, /Name is required/],
    ['name too long', { ...valid, name: 'x'.repeat(121) }, /Name is required/],
    ['empty phone', { ...valid, phone: '' }, /Phone is required/],
    ['invalid email', { ...valid, email: 'not-an-email' }, /valid email/],
    ['dates that are not strings', { ...valid, checkIn: 20300712 }, /dates are required/],
  ])('rejects %s with 400 before touching the database', async (_label, body, message) => {
    const res = await reserve(post('/api/public/stays/reservations', body));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).error).toMatch(message);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it('with valid input, and only then, reaches for the database', async () => {
    await expect(reserve(post('/api/public/stays/reservations', valid))).rejects.toThrow(/database must not be touched/);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });
  it('ignores a price sent by the client: there is no such field to trust', async () => {
    // Same path as the valid request: totalCents is simply not read.
    await expect(
      reserve(post('/api/public/stays/reservations', { ...valid, totalCents: 1, dueNowCents: 0 }))
    ).rejects.toThrow(/database must not be touched/);
  });
});

describe('GET /api/public/ical/<token>', () => {
  it.each(['not-a-token', '123', '../../etc/passwd'])('answers 404 for %s without a query', async (token) => {
    const res = await ical(get(`/api/public/ical/${encodeURIComponent(token)}.ics`), {
      params: Promise.resolve({ token: `${token}.ics` }),
    });
    expect(res.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/stripe/webhook', () => {
  it('refuses an unsigned event without reading the database', async () => {
    const res = await webhook(
      post('/api/stripe/webhook', { type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    );
    expect(res.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it('refuses a forged signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    try {
      const res = await webhook(
        post(
          '/api/stripe/webhook',
          { type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } },
          { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}` }
        )
      );
      expect(res.status).toBe(400);
      expect(createAdminClient).not.toHaveBeenCalled();
    } finally {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
});
