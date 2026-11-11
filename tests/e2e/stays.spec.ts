import { expect, test } from '@playwright/test';
import { isoDateFromNow, stagingAdmin } from './fixture';
import { createVerticalBusiness, embedWidget, loginTo, type VerticalBusiness } from './verticals-fixture';

test.describe.serial('stays product', () => {
  let biz: VerticalBusiness;
  let unitId = '';
  let unitName = '';
  let cancelToken = '';
  const checkIn = isoDateFromNow(14);
  const checkOut = isoDateFromNow(17);

  test.beforeAll(async () => {
    biz = await createVerticalBusiness('stays');
    unitName = `Sea room ${biz.run}`;
  });
  test.afterAll(async () => {
    await biz?.cleanup();
  });

  test('the owner lands on the stays calendar and adds a unit', async ({ page }) => {
    await loginTo(page, biz, /\/stays$/);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Units' })).toBeVisible();
    // No restaurant screens for a stays business, by menu or by URL.
    await expect(nav.getByRole('link', { name: 'Floor plan' })).toHaveCount(0);
    await page.goto('/bookings/new');
    await expect(page).toHaveURL(/\/stays$/);

    await nav.getByRole('link', { name: 'Units' }).click();
    await expect(page.getByRole('heading', { name: 'Units', exact: true })).toBeVisible();
    await page.getByLabel('Name').fill(unitName);
    await page.getByLabel('Price per night (EUR)').fill('100');
    await page.getByLabel('Cleaning fee per stay (EUR)').fill('20');
    await page.getByLabel('Maximum guests').fill('2');
    await page.getByRole('button', { name: 'Add unit' }).click();
    await expect(page).toHaveURL(/\/stays\/units\/[0-9a-f-]{36}\?saved=1/);

    const { data } = await stagingAdmin()
      .from('stay_units')
      .select('id, restaurant_id, name, base_price_cents, cleaning_fee_cents, max_guests, active')
      .eq('restaurant_id', biz.id);
    expect(data).toEqual([
      expect.objectContaining({ name: unitName, base_price_cents: 10000, cleaning_fee_cents: 2000, max_guests: 2, active: true }),
    ]);
    unitId = data![0].id;
  });

  test('a guest reserves through the widget on another website', async ({ page, baseURL }) => {
    const guestName = `Stay Guest ${biz.run}`;
    const widget = await embedWidget(page, baseURL, biz.id);

    const dates = widget.locator('input[type="date"]');
    await expect(dates).toHaveCount(2);
    await expect(widget.getByText('Choose your dates to see what is available.')).toBeVisible();
    await dates.nth(0).fill(checkIn);
    await dates.nth(1).fill(checkOut);

    const card = widget.locator('.tfs-unit');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.tfs-name')).toHaveText(unitName);
    // 3 nights × 100 + 20 cleaning
    await expect(card.locator('.tfs-price')).toContainText('320');
    await expect(card).toContainText('3 nights');
    await expect(card).toContainText('Pay at the property');

    await card.getByRole('button', { name: 'Select' }).click();
    await widget.locator('input[type="text"]').fill(guestName);
    await widget.locator('input[type="tel"]').fill('+351 910 000 003');
    await widget.locator('input[type="email"]').fill(`stay-guest-${biz.run}@example.test`);
    await widget.locator('textarea').fill('Arriving around 18:00');
    await widget.getByRole('button', { name: 'Reserve', exact: true }).click();

    await expect(widget.getByRole('heading', { name: 'Reservation confirmed!' })).toBeVisible();

    const { data } = await stagingAdmin()
      .from('stay_reservations')
      .select('restaurant_id, unit_id, check_in, check_out, guests, status, source, total_cents, notes, cancel_token')
      .eq('guest_name', guestName);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      restaurant_id: biz.id,
      unit_id: unitId,
      check_in: checkIn,
      check_out: checkOut,
      guests: 2,
      status: 'confirmed',
      source: 'widget',
      total_cents: 32000,
      notes: 'Arriving around 18:00',
    });
    cancelToken = data![0].cancel_token;

    // The dates are gone for the next visitor.
    const avail = await page.request.get(
      `${baseURL}/api/public/stays/availability?restaurant=${biz.id}&checkIn=${checkIn}&checkOut=${checkOut}&guests=2`
    );
    expect((await avail.json()).units).toEqual([]);
  });

  test('the owner sees it, cannot double-book the unit, and adds a phone reservation', async ({ page }) => {
    await loginTo(page, biz, /\/stays$/);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reservations' }).click();
    await expect(page.getByRole('heading', { name: 'Upcoming reservations' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(`Stay Guest ${biz.run}`) });
    await expect(row).toContainText(unitName);
    await expect(row).toContainText(checkIn);
    await expect(row).toContainText('confirmed');

    const fill = async (from: string, to: string, name: string) => {
      await page.goto('/stays/new');
      await page.locator('#unitId').selectOption(unitId);
      await page.locator('#checkIn').fill(from);
      await page.locator('#checkOut').fill(to);
      await page.locator('#name').fill(name);
      await page.getByRole('button', { name: 'Create reservation' }).click();
    };

    await fill(isoDateFromNow(16), isoDateFromNow(18), `Clash ${biz.run}`);
    await expect(page).toHaveURL(/\/stays\/new\?error=/);
    await expect(page.getByRole('alert').filter({ hasText: 'Those dates are already taken for this unit.' })).toBeVisible();

    await fill(isoDateFromNow(17), isoDateFromNow(19), `Phone Guest ${biz.run}`);
    await expect(page).toHaveURL(/\/stays\/reservations$/);
    await expect(page.getByRole('row', { name: new RegExp(`Phone Guest ${biz.run}`) })).toBeVisible();

    const { data } = await stagingAdmin()
      .from('stay_reservations')
      .select('guest_name, source, status')
      .eq('restaurant_id', biz.id)
      .order('check_in');
    expect(data).toEqual([
      { guest_name: `Stay Guest ${biz.run}`, source: 'widget', status: 'confirmed' },
      { guest_name: `Phone Guest ${biz.run}`, source: 'manual', status: 'confirmed' },
    ]);
  });

  test('the guest cancels from the link in the email and the dates open up again', async ({ page, baseURL }) => {
    await page.goto(`/cancel/${cancelToken}`);
    await expect(page.getByRole('heading', { name: 'Cancel reservation' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, cancel my reservation' }).click();
    await expect(page.getByText('Your reservation has been cancelled.')).toBeVisible();

    const { data } = await stagingAdmin().from('stay_reservations').select('status').eq('cancel_token', cancelToken);
    expect(data).toEqual([{ status: 'cancelled' }]);

    const avail = await page.request.get(
      `${baseURL}/api/public/stays/availability?restaurant=${biz.id}&checkIn=${checkIn}&checkOut=${checkOut}&guests=2`
    );
    expect((await avail.json()).units).toEqual([expect.objectContaining({ id: unitId, totalCents: 32000 })]);
  });

  test('the calendar export only answers to the unit’s secret link', async ({ page, baseURL }) => {
    const { data } = await stagingAdmin().from('stay_units').select('ical_token').eq('id', unitId).single<{ ical_token: string }>();
    const feed = await page.request.get(`${baseURL}/api/public/ical/${data!.ical_token}`);
    expect(feed.status()).toBe(200);
    const text = await feed.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    // The phone reservation blocks its nights for the channels; the cancelled one does not.
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain(`DTSTART;VALUE=DATE:${isoDateFromNow(17).replaceAll('-', '')}`);

    const unknown = await page.request.get(`${baseURL}/api/public/ical/00000000-0000-4000-8000-000000000000`);
    expect(unknown.status()).toBe(404);
  });
});
