import { expect, type Page } from '@playwright/test';
import { readFixture } from './fixture';

export async function loginAsOwner(page: Page) {
  const fx = readFixture();
  await page.goto('/login');
  await page.getByLabel('Email').fill(fx.ownerEmail);
  await page.getByLabel('Password').fill(fx.ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Upcoming bookings' })).toBeVisible();
  return fx;
}
