import { expect, test } from '@playwright/test';
import { readFixture } from './fixture';
import { loginAsOwner } from './helpers';

test.describe('owner authentication', () => {
  test('dashboard routes redirect anonymous visitors to /login', async ({ page }) => {
    for (const path of ['/', '/settings', '/bookings/new', '/day']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('heading', { name: 'TableFront' })).toBeVisible();
    }
  });

  test('wrong password shows an error and stays on /login', async ({ page }) => {
    const fx = readFixture();
    await page.goto('/login');
    await page.getByLabel('Email').fill(fx.ownerEmail);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login\?error=/);
  });

  test('valid credentials land on the bookings dashboard of the owner restaurant', async ({ page }) => {
    const fx = await loginAsOwner(page);
    await expect(page.getByRole('banner').getByText(fx.restaurantName)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Bookings' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    // /login bounces a signed-in owner back to the dashboard.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);
  });

  test('sign out returns to /login and locks the dashboard again', async ({ page }) => {
    await loginAsOwner(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});
