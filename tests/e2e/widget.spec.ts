import { expect, test } from '@playwright/test';
import { isoDateFromNow, readFixture, stagingAdmin } from './fixture';

test.describe('guest booking widget (embedded on a third-party page)', () => {
  test('guest picks a date and slot, books, and the booking appears for the owner', async ({ page, baseURL }) => {
    const fx = readFixture();
    const date = isoDateFromNow(6);
    const guestName = `Widget Guest ${fx.run}`;

    // A host page on a different origin (about:blank) embedding the widget, like a restaurant site would.
    await page.setContent(`
      <!doctype html><html><body>
        <div data-tablefront-widget data-restaurant="${fx.restaurantId}"></div>
        <script src="${baseURL}/widget.js" async></script>
      </body></html>`);

    const widget = page.locator('[data-tablefront-widget]');
    const dateInput = widget.locator('input[type="date"]');
    await expect(dateInput).toBeVisible();
    await expect(widget.getByText('Pick a date to see available times.')).toBeVisible();

    await dateInput.fill(date);
    const slots = widget.locator('.tf-slot');
    await expect(slots.first()).toBeVisible();
    await expect(slots).toHaveCount(20);

    await widget.locator('select').selectOption('3');
    await slots.filter({ hasText: '20:30' }).click();
    await widget.locator('input[type="text"]').fill(guestName);
    await widget.locator('input[type="tel"]').fill('+351 910 000 002');
    await widget.locator('input[type="email"]').fill(`widget-guest-${fx.run}@example.test`);
    await widget.locator('textarea').fill('Near the window, please');
    await widget.getByRole('button', { name: 'Book table' }).click();

    await expect(widget.getByRole('heading', { name: 'Booking confirmed!' })).toBeVisible();
    await expect(widget.getByText(`${date} at 20:30 for 3 guests`)).toBeVisible();

    const { data } = await stagingAdmin()
      .from('bookings')
      .select('restaurant_id, source, status, party_size, time_slot, date, notes, guest_lang')
      .eq('guest_name', guestName);
    expect(data).toEqual([
      {
        restaurant_id: fx.restaurantId,
        source: 'widget',
        status: 'confirmed',
        party_size: 3,
        time_slot: '20:30:00',
        date,
        notes: 'Near the window, please',
        guest_lang: 'en',
      },
    ]);

    // The confirmation replaces the form; the slot now shows 3 fewer covers to the next guest.
    await expect(dateInput).toHaveCount(0);
    const avail = await page.request.get(`${baseURL}/api/public/availability?restaurant=${fx.restaurantId}&date=${date}`);
    const body = await avail.json();
    expect(body.slots.find((s: { time: string }) => s.time === '20:30')).toEqual({ time: '20:30', remaining: 21 });
  });
});
