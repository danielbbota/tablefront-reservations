import { expect, test } from '@playwright/test';
import { isoDateFromNow, readFixture } from './fixture';

test.describe('public widget API over HTTP', () => {
  test('config + availability are CORS-open and scoped to the restaurant', async ({ request }) => {
    const fx = readFixture();

    const cfg = await request.get(`/api/public/config?restaurant=${fx.restaurantId}`);
    expect(cfg.status()).toBe(200);
    expect(cfg.headers()['access-control-allow-origin']).toBe('*');
    expect(await cfg.json()).toMatchObject({ restaurant: { id: fx.restaurantId, name: fx.restaurantName }, language: 'en' });

    const avail = await request.get(`/api/public/availability?restaurant=${fx.restaurantId}&date=${isoDateFromNow(4)}`);
    expect(avail.status()).toBe(200);
    const body = await avail.json();
    expect(body.slots.length).toBe(20);
    expect(body.slots[0]).toEqual({ time: '12:00', remaining: 24 });
  });

  test('preflight and validation responses carry CORS headers', async ({ request }) => {
    const pre = await request.fetch('/api/public/bookings', { method: 'OPTIONS' });
    expect(pre.status()).toBe(204);
    expect(pre.headers()['access-control-allow-origin']).toBe('*');

    const bad = await request.get('/api/public/availability');
    expect(bad.status()).toBe(400);
    expect(bad.headers()['access-control-allow-origin']).toBe('*');
  });

  test('anonymous visitors cannot reach the dashboard APIs or admin without the secret', async ({ request }) => {
    const admin = await request.post('/api/admin/restaurants', { data: { name: 'x', slug: 'x' } });
    expect(admin.status()).toBe(401);
    const cron = await request.get('/api/cron/reminders');
    expect([401, 403]).toContain(cron.status());
  });
});
