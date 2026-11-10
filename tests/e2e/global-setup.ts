// Creates one restaurant + one owner on STAGING for the whole e2e run.
import { randomUUID } from 'node:crypto';
import { OPEN_ALL_WEEK, stagingAdmin, writeFixture, type E2EFixture } from './fixture';

export default async function globalSetup() {
  const supabase = stagingAdmin();
  const run = randomUUID().slice(0, 8);

  // Sweep leftovers from crashed runs older than one hour.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await supabase.from('restaurants').delete().like('slug', 'test-e2e-%').lt('created_at', cutoff);
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) {
    if (/^e2e-owner-.*@example\.test$/.test(u.email ?? '') && u.created_at < cutoff) {
      await supabase.auth.admin.deleteUser(u.id);
    }
  }

  const { data: restaurant, error: restErr } = await supabase
    .from('restaurants')
    .insert({
      name: `E2E Bistro ${run}`,
      slug: `test-e2e-${run}`,
      timezone: 'Europe/Lisbon',
      slot_interval_minutes: 30,
      operating_hours: OPEN_ALL_WEEK,
      default_max_covers: 24,
      language: 'en',
      turn_time_minutes: 90,
      brand: {},
    })
    .select('id, name, slug')
    .single<{ id: string; name: string; slug: string }>();
  if (restErr || !restaurant) throw new Error(`e2e setup: could not create restaurant: ${restErr?.message}`);

  const ownerEmail = `e2e-owner-${run}@example.test`;
  const ownerPassword = `E2e-${randomUUID()}`;
  const { data: created, error: userErr } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });
  if (userErr || !created.user) {
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    throw new Error(`e2e setup: could not create owner user: ${userErr?.message}`);
  }
  const { error: ownerErr } = await supabase
    .from('owners')
    .insert({ id: created.user.id, restaurant_id: restaurant.id, email: ownerEmail });
  if (ownerErr) {
    await supabase.auth.admin.deleteUser(created.user.id);
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    throw new Error(`e2e setup: could not link owner: ${ownerErr.message}`);
  }

  const fx: E2EFixture = {
    run,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    restaurantSlug: restaurant.slug,
    ownerUserId: created.user.id,
    ownerEmail,
    ownerPassword,
  };
  writeFixture(fx);
  console.log(`e2e fixture: ${fx.restaurantName} (${fx.restaurantSlug}) on ${process.env.TEST_SUPABASE_URL}`);
}
