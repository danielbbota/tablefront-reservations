import { expect, test } from '@playwright/test';
import { isoDateFromNow, stagingAdmin } from './fixture';
import { createVerticalBusiness, embedWidget, loginTo, type VerticalBusiness } from './verticals-fixture';

const HOURS = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '09:00', close: '18:00', closed: false }])
);

test.describe.serial('appointments product', () => {
  let biz: VerticalBusiness;
  let serviceId = '';
  let staffId = '';
  let cancelToken = '';
  const date = isoDateFromNow(8);

  test.beforeAll(async () => {
    // A 15-minute grid, so 10:15 is a time the dashboard form accepts.
    biz = await createVerticalBusiness('appointments', { operating_hours: HOURS, slot_interval_minutes: 15 });
    const supabase = stagingAdmin();
    const { data: service, error } = await supabase
      .from('services')
      .insert({ restaurant_id: biz.id, name: 'Cut', category: 'Hair', duration_minutes: 30, price_cents: 2500 })
      .select('id')
      .single<{ id: string }>();
    if (error || !service) throw new Error(`e2e: could not seed service: ${error?.message}`);
    serviceId = service.id;
    const { data: staff } = await supabase
      .from('staff')
      .insert({ restaurant_id: biz.id, name: 'Rui' })
      .select('id')
      .single<{ id: string }>();
    staffId = staff!.id;
    await supabase.from('staff_services').insert({ restaurant_id: biz.id, staff_id: staffId, service_id: serviceId });
  });
  test.afterAll(async () => {
    await biz?.cleanup();
  });

  test('the owner lands on the agenda and adds a service', async ({ page }) => {
    await loginTo(page, biz, /\/agenda$/);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Team' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Floor plan' })).toHaveCount(0);
    // Neither the restaurant nor the stays screens are reachable.
    await page.goto('/floor-plan');
    await expect(page).toHaveURL(/\/agenda$/);
    await page.goto('/stays/units');
    await expect(page).toHaveURL(/\/agenda$/);

    await nav.getByRole('link', { name: 'Services' }).click();
    await expect(page.getByRole('heading', { name: 'Services', exact: true })).toBeVisible();
    await expect(page.getByText('Cut', { exact: true })).toBeVisible();

    await page.getByLabel('Name').fill('Beard trim');
    await page.getByLabel('Duration (minutes)').fill('20');
    await page.getByLabel('Price (EUR)').fill('12.50');
    await page.getByRole('button', { name: 'Add service' }).click();
    await expect(page).toHaveURL(/\/services\?saved=1/);
    const added = page.getByRole('listitem').filter({ hasText: 'Beard trim' });
    await expect(added).toContainText('€12.50');
    // Nobody performs it yet, and the owner is told so.
    await expect(added).toContainText('no professional assigned');

    const { data } = await stagingAdmin()
      .from('services')
      .select('name, duration_minutes, price_cents, active')
      .eq('restaurant_id', biz.id)
      .eq('name', 'Beard trim');
    expect(data).toEqual([{ name: 'Beard trim', duration_minutes: 20, price_cents: 1250, active: true }]);
  });

  test('a client books through the widget on another website', async ({ page, baseURL }) => {
    const clientName = `Appt Client ${biz.run}`;
    const widget = await embedWidget(page, baseURL, biz.id);

    // Only services somebody performs are offered: "Beard trim" has nobody yet.
    const services = widget.locator('.tfa-svc');
    await expect(services.filter({ hasText: 'Cut' })).toBeVisible();
    await expect(services.filter({ hasText: 'Beard trim' })).toHaveCount(0);
    await services.filter({ hasText: 'Cut' }).click();

    await widget.locator('input[type="date"]').fill(date);
    const slots = widget.locator('.tf-slot');
    await expect(slots.first()).toHaveText('09:00');
    await slots.filter({ hasText: '10:00' }).click();

    await widget.locator('input[type="text"]').fill(clientName);
    await widget.locator('input[type="tel"]').fill('+351 910 000 004');
    await widget.locator('input[type="email"]').fill(`appt-client-${biz.run}@example.test`);
    await widget.getByRole('button', { name: 'Book appointment' }).click();

    await expect(widget.getByRole('heading', { name: 'Appointment confirmed!' })).toBeVisible();
    await expect(widget.getByText('With Rui.')).toBeVisible();

    const { data } = await stagingAdmin()
      .from('appointments')
      .select('restaurant_id, service_id, staff_id, date, start_time, end_time, service_name, price_cents, status, source, cancel_token')
      .eq('guest_name', clientName);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      restaurant_id: biz.id,
      service_id: serviceId,
      staff_id: staffId,
      date,
      start_time: '10:00:00',
      end_time: '10:30:00',
      service_name: 'Cut',
      price_cents: 2500,
      status: 'confirmed',
      source: 'widget',
    });
    cancelToken = data![0].cancel_token;

    const avail = await page.request.get(
      `${baseURL}/api/public/appointments/availability?restaurant=${biz.id}&service=${serviceId}&staff=any&date=${date}`
    );
    const times = ((await avail.json()).slots as { time: string }[]).map((s) => s.time);
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:15');
    expect(times).toContain('10:30');
  });

  test('the owner sees it and cannot double-book the professional', async ({ page }) => {
    await loginTo(page, biz, /\/agenda$/);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Appointments' }).click();
    await expect(page.getByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(`Appt Client ${biz.run}`) });
    await expect(row).toContainText('Cut');
    await expect(row).toContainText('Rui');
    await expect(row).toContainText('10:00');
    await expect(row).toContainText('confirmed');

    const fill = async (time: string, name: string) => {
      await page.goto('/agenda/new');
      await page.locator('#serviceId').selectOption(serviceId);
      await page.locator('#staffId').selectOption(staffId);
      await page.locator('#date').fill(date);
      await page.locator('#time').fill(time);
      await page.locator('#name').fill(name);
      await page.getByRole('button', { name: 'Create appointment' }).click();
    };

    await fill('10:15', `Clash ${biz.run}`);
    await expect(page).toHaveURL(/\/agenda\/new\?.*error=/);
    await expect(page.getByText('Rui already has an appointment at that time.')).toBeVisible();

    await fill('11:00', `Walk-in ${biz.run}`);
    await expect(page).toHaveURL(new RegExp(`/agenda\\?date=${date}$`));
    await expect(page.getByText(`Walk-in ${biz.run}`).first()).toBeVisible();

    const { data } = await stagingAdmin()
      .from('appointments')
      .select('guest_name, start_time, source, status')
      .eq('restaurant_id', biz.id)
      .order('start_time');
    expect(data).toEqual([
      { guest_name: `Appt Client ${biz.run}`, start_time: '10:00:00', source: 'widget', status: 'confirmed' },
      { guest_name: `Walk-in ${biz.run}`, start_time: '11:00:00', source: 'manual', status: 'confirmed' },
    ]);
  });

  test('the client cancels from the link in the email and the time is free again', async ({ page, baseURL }) => {
    await page.goto(`/cancel/${cancelToken}`);
    await expect(page.getByRole('heading', { name: 'Cancel appointment' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, cancel my appointment' }).click();
    await expect(page.getByText('Your appointment has been cancelled.')).toBeVisible();

    const { data } = await stagingAdmin().from('appointments').select('status').eq('cancel_token', cancelToken);
    expect(data).toEqual([{ status: 'cancelled' }]);

    const avail = await page.request.get(
      `${baseURL}/api/public/appointments/availability?restaurant=${biz.id}&service=${serviceId}&staff=any&date=${date}`
    );
    const times = ((await avail.json()).slots as { time: string }[]).map((s) => s.time);
    expect(times).toContain('10:00');
  });
});
