import { readFixture, removeFixtureFile, stagingAdmin } from './fixture';

export default async function globalTeardown() {
  let fx;
  try {
    fx = readFixture();
  } catch {
    return;
  }
  const supabase = stagingAdmin();
  // Deleting the restaurant cascades to owners, bookings, rules and floor rows.
  await supabase.from('restaurants').delete().eq('id', fx.restaurantId);
  await supabase.auth.admin.deleteUser(fx.ownerUserId);
  removeFixtureFile();
}
