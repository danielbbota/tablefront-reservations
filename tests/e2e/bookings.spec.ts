import { expect, test } from '@playwright/test';
import { isoDateFromNow, stagingAdmin } from './fixture';
import { loginAsOwner } from './helpers';

test.describe('manual bookings in the dashboard', () => {
  test('owner adds a manual booking, sees it listed, cancels and re-confirms it', async ({ page }) => {
    const fx = await loginAsOwner(page);
    const guestName = `E2E Guest ${fx.run}`;
    const date = isoDateFromNow(3);

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add booking' }).click();
    await expect(page).toHaveURL(/\/bookings\/new$/);
    await expect(page.getByRole('heading', { name: 'Add booking' })).toBeVisible();

    await page.getByLabel('Date').fill(date);
    await page.getByLabel('Time').fill('19:30');
    await page.getByLabel('Party size').fill('4');
    await page.getByLabel('Guest name').fill(guestName);
    await page.getByLabel('Phone').fill('+351 910 000 001');
    await page.getByLabel('Email').fill(`e2e-guest-${fx.run}@example.test`);
    await page.getByLabel('Notes').fill('Birthday');
    await page.getByRole('button', { name: 'Create booking' }).click();

    await expect(page).toHaveURL(/\/$/);
    const row = page.getByRole('row', { name: new RegExp(guestName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(date);
    await expect(row).toContainText('19:30');
    await expect(row).toContainText('confirmed');
    await expect(row).toContainText('manual');
    await expect(row).toContainText('Birthday');

    // Manual bookings are never capped: stored under the owner's restaurant only.
    const { data } = await stagingAdmin().from('bookings').select('restaurant_id, source, status, party_size').eq('guest_name', guestName);
    expect(data).toEqual([{ restaurant_id: fx.restaurantId, source: 'manual', status: 'confirmed', party_size: 4 }]);

    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toContainText('cancelled');
    await expect(row.getByRole('button', { name: 'Re-confirm' })).toBeVisible();

    await row.getByRole('button', { name: 'Re-confirm' }).click();
    await expect(row).toContainText('confirmed');
    await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('validation errors on the manual booking form are shown inline', async ({ page }) => {
    await loginAsOwner(page);
    await page.goto('/bookings/new');
    // Bypass the browser's required-field checks to exercise the server action.
    await page.evaluate(() => document.querySelectorAll('[required]').forEach((el) => el.removeAttribute('required')));
    await page.getByRole('button', { name: 'Create booking' }).click();
    await expect(page).toHaveURL(/\/bookings\/new\?error=/);
    await expect(page.getByText('Guest name is required.')).toBeVisible();
  });
});
