// Request validation of the public widget API, exercised by calling the route
// handlers directly. The Supabase client is mocked to prove that invalid input
// is rejected BEFORE any database access.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const createAdminClient = vi.fn(() => {
  throw new Error('database must not be touched for invalid input');
});
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));
vi.mock('@/lib/email', () => ({
  sendGuestConfirmation: vi.fn(),
  sendOwnerNotification: vi.fn(),
  sendGuestCancellation: vi.fn(),
}));

const { GET: availability, OPTIONS: availabilityOptions } = await import('@/app/api/public/availability/route');
const { GET: config } = await import('@/app/api/public/config/route');
const { POST: createBooking } = await import('@/app/api/public/bookings/route');

const base = 'http://localhost:3100';
const get = (path: string) => new NextRequest(new URL(path, base));
const post = (path: string, body: unknown) =>
  new NextRequest(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const validBooking = {
  restaurant: '00000000-0000-0000-0000-000000000001',
  date: '2030-01-01',
  time: '19:00',
  partySize: 2,
  name: 'Ada',
  phone: '+351 900 000 000',
  email: 'ada@example.test',
};

beforeEach(() => {
  createAdminClient.mockClear();
});

describe('GET /api/public/availability', () => {
  it('OPTIONS preflight is CORS-open', async () => {
    const res = await availabilityOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it.each([
    ['missing both', '/api/public/availability'],
    ['missing date', '/api/public/availability?restaurant=abc'],
    ['missing restaurant', '/api/public/availability?date=2030-01-01'],
    ['malformed date', '/api/public/availability?restaurant=abc&date=01/01/2030'],
    ['date with time', '/api/public/availability?restaurant=abc&date=2030-01-01T00:00'],
  ])('rejects %s with 400 before touching the database', async (_label, path) => {
    const res = await availability(get(path));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).error).toMatch(/restaurant and date/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/public/config', () => {
  it('rejects a missing restaurant id with 400', async () => {
    const res = await config(get('/api/public/config'));
    expect(res.status).toBe(400);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/public/bookings validation', () => {
  it('rejects a non-JSON body', async () => {
    const res = await createBooking(post('/api/public/bookings', '{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['missing restaurant', { ...validBooking, restaurant: '' }, /Missing restaurant/],
    ['bad date', { ...validBooking, date: '2030-1-1' }, /Invalid date/],
    ['bad time', { ...validBooking, time: '7pm' }, /Invalid time/],
    ['party size 0', { ...validBooking, partySize: 0 }, /Invalid party size/],
    ['party size 13 (above MAX_PARTY_SIZE)', { ...validBooking, partySize: 13 }, /Invalid party size/],
    ['fractional party size', { ...validBooking, partySize: 2.5 }, /Invalid party size/],
    ['non-numeric party size', { ...validBooking, partySize: 'two' }, /Invalid party size/],
    ['empty name', { ...validBooking, name: '   ' }, /Name is required/],
    ['name too long', { ...validBooking, name: 'x'.repeat(121) }, /Name is required/],
    ['empty phone', { ...validBooking, phone: '' }, /Phone is required/],
    ['phone too long', { ...validBooking, phone: '9'.repeat(41) }, /Phone is required/],
    ['invalid email', { ...validBooking, email: 'not-an-email' }, /valid email/],
    ['email with spaces', { ...validBooking, email: 'a b@example.test' }, /valid email/],
  ])('rejects %s with 400 before touching the database', async (_label, body, message) => {
    const res = await createBooking(post('/api/public/bookings', body));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).error).toMatch(message);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it('accepts the maximum party size and only then reaches for the database', async () => {
    // With valid input the handler proceeds to the (mocked, throwing) client.
    await expect(createBooking(post('/api/public/bookings', { ...validBooking, partySize: 12 }))).rejects.toThrow(
      /database must not be touched/
    );
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });
});
