// Throwaway stays / appointments businesses for the e2e specs of those
// products. The global fixture stays a restaurant; these are created and
// removed by the spec that uses them.
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { stagingAdmin } from './fixture';

export type VerticalBusiness = {
  run: string;
  id: string;
  name: string;
  ownerEmail: string;
  ownerPassword: string;
  cleanup: () => Promise<void>;
};

export async function createVerticalBusiness(
  type: 'stays' | 'appointments',
  overrides: Record<string, unknown> = {}
): Promise<VerticalBusiness> {
  const supabase = stagingAdmin();
  const run = randomUUID().slice(0, 8);
  const name = `E2E ${type === 'stays' ? 'Guesthouse' : 'Salon'} ${run}`;

  // Slug prefix `test-e2e-` and email prefix `e2e-owner-`: leftovers from a
  // crashed run are swept by global-setup.ts.
  const { data: business, error } = await supabase
    .from('restaurants')
    .insert({
      name,
      slug: `test-e2e-${type}-${run}`,
      business_type: type,
      timezone: 'Europe/Lisbon',
      language: 'en',
      default_max_covers: 24,
      brand: {},
      ...overrides,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !business) throw new Error(`e2e: could not create ${type} business: ${error?.message}`);

  const ownerEmail = `e2e-owner-${type}-${run}@example.test`;
  const ownerPassword = `E2e-${randomUUID()}`;
  const { data: created, error: userErr } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });
  if (userErr || !created.user) {
    await supabase.from('restaurants').delete().eq('id', business.id);
    throw new Error(`e2e: could not create owner: ${userErr?.message}`);
  }
  const userId = created.user.id;
  const { error: ownerErr } = await supabase
    .from('owners')
    .insert({ id: userId, restaurant_id: business.id, email: ownerEmail });
  if (ownerErr) {
    await supabase.auth.admin.deleteUser(userId);
    await supabase.from('restaurants').delete().eq('id', business.id);
    throw new Error(`e2e: could not link owner: ${ownerErr.message}`);
  }

  return {
    run,
    id: business.id,
    name,
    ownerEmail,
    ownerPassword,
    cleanup: async () => {
      // Appointments reference staff without a cascade: remove them first.
      await supabase.from('appointments').delete().eq('restaurant_id', business.id);
      await supabase.from('restaurants').delete().eq('id', business.id);
      await supabase.auth.admin.deleteUser(userId);
    },
  };
}

/** Sign in and wait for the product's own home page. */
export async function loginTo(page: Page, biz: VerticalBusiness, home: RegExp) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(biz.ownerEmail);
  await page.getByLabel('Password').fill(biz.ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(home);
}

/** A third-party page embedding the widget, like a customer's own website. */
export async function embedWidget(page: Page, baseURL: string | undefined, businessId: string) {
  await page.setContent(`
    <!doctype html><html><body>
      <div data-tablefront-widget data-restaurant="${businessId}"></div>
      <script src="${baseURL}/widget.js" async></script>
    </body></html>`);
  return page.locator('[data-tablefront-widget]');
}
