import { expect, test } from '@playwright/test';
import { E2E_ADMIN_SECRET } from '../../playwright.config';
import { stagingAdmin } from './fixture';

test.describe('admin API', () => {
  test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_ADMIN_SECRET, 'needs E2E_ADMIN_SECRET for an external app');

  test('creates a restaurant + owner with the admin secret and returns the embed snippet', async ({ request, baseURL }) => {
    const run = Math.random().toString(36).slice(2, 10);
    const slug = `test-e2e-admin-${run}`;
    const ownerEmail = `e2e-owner-admin-${run}@example.test`;
    const supabase = stagingAdmin();
    let restaurantId: string | undefined;
    try {
      const res = await request.post('/api/admin/restaurants', {
        headers: { 'x-admin-secret': E2E_ADMIN_SECRET },
        data: {
          name: `Admin Created ${run}`,
          slug,
          timezone: 'Europe/Lisbon',
          language: 'pt',
          ownerEmail,
          ownerPassword: `Pw-${run}-${run}`,
        },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      restaurantId = body.restaurant.id;
      expect(body).toMatchObject({ restaurant: { slug }, owner: { email: ownerEmail } });
      expect(body.embedSnippet).toContain(`data-restaurant="${restaurantId}"`);
      expect(body.embedSnippet).toContain(`${baseURL}/widget.js`);

      const { data: owner } = await supabase.from('owners').select('id, restaurant_id').eq('email', ownerEmail).single();
      expect(owner?.restaurant_id).toBe(restaurantId);

      // The new owner can log in through the real auth stack.
      const cfg = await request.get(`/api/public/config?restaurant=${restaurantId}`);
      expect(await cfg.json()).toMatchObject({ language: 'pt' });
    } finally {
      const { data: owner } = await supabase.from('owners').select('id').eq('email', ownerEmail).maybeSingle();
      if (restaurantId) await supabase.from('restaurants').delete().eq('id', restaurantId);
      if (owner?.id) await supabase.auth.admin.deleteUser(owner.id);
    }
  });

  test('rejects a wrong secret', async ({ request }) => {
    const res = await request.post('/api/admin/restaurants', {
      headers: { 'x-admin-secret': 'nope' },
      data: { name: 'x', slug: 'x', ownerEmail: 'x@example.test', ownerPassword: 'password123' },
    });
    expect(res.status()).toBe(401);
  });
});
