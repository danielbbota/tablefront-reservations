import { expect, test } from '@playwright/test';
import { E2E_ADMIN_SECRET } from '../../playwright.config';
import { stagingAdmin } from './fixture';

/**
 * The /admin form shows only the settings the chosen product has: time slots
 * for tables and appointments, a cover cap per slot for tables only.
 */
test.describe('admin form', () => {
  test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_ADMIN_SECRET, 'needs E2E_ADMIN_SECRET for an external app');

  test('hides the restaurant-only fields for the other products', async ({ page }) => {
    await page.goto('/admin');
    const product = page.locator('select[name="businessType"]');
    const interval = page.locator('input[name="slotInterval"]');
    const covers = page.locator('input[name="defaultMaxCovers"]');

    await expect(product).toHaveValue('restaurant');
    await expect(interval).toBeVisible();
    await expect(covers).toBeVisible();

    await product.selectOption('appointments');
    await expect(interval).toBeVisible();
    await expect(covers).toHaveCount(0);

    await product.selectOption('stays');
    await expect(interval).toHaveCount(0);
    await expect(covers).toHaveCount(0);

    await product.selectOption('restaurant');
    await expect(interval).toBeVisible();
    await expect(covers).toBeVisible();
  });

  test('creates a stays business without sending the hidden fields', async ({ page }) => {
    const run = Math.random().toString(36).slice(2, 10);
    const slug = `test-e2e-adminform-${run}`;
    const ownerEmail = `e2e-owner-adminform-${run}@example.test`;
    const supabase = stagingAdmin();
    try {
      await page.goto('/admin');
      await page.locator('input[type="password"]').fill(E2E_ADMIN_SECRET);
      await page.locator('select[name="businessType"]').selectOption('stays');
      await page.locator('input[name="name"]').fill(`Admin Form ${run}`);
      await page.locator('input[name="slug"]').fill(slug);
      await page.locator('input[name="ownerEmail"]').fill(ownerEmail);
      await page.locator('input[name="ownerPassword"]').fill(`Pw-${run}-${run}`);

      const [request] = await Promise.all([
        page.waitForRequest((r) => r.url().endsWith('/api/admin/restaurants') && r.method() === 'POST'),
        page.getByRole('button', { name: 'Create business' }).click(),
      ]);
      const sent = request.postDataJSON();
      expect(sent.businessType).toBe('stays');
      expect(sent).not.toHaveProperty('slotIntervalMinutes');
      expect(sent).not.toHaveProperty('defaultMaxCovers');

      await expect(page.getByText(`Created “Admin Form ${run}” (${slug})`)).toBeVisible();

      const { data: row } = await supabase
        .from('restaurants')
        .select('business_type, slot_interval_minutes, default_max_covers')
        .eq('slug', slug)
        .single();
      expect(row).toEqual({ business_type: 'stays', slot_interval_minutes: 30, default_max_covers: 20 });
    } finally {
      const { data: owner } = await supabase.from('owners').select('id').eq('email', ownerEmail).maybeSingle();
      await supabase.from('restaurants').delete().eq('slug', slug);
      if (owner?.id) await supabase.auth.admin.deleteUser(owner.id);
    }
  });
});
