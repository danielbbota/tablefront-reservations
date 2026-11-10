// =============================================================================
// TableFront — RLS tenant-isolation test (integration layer)
//
// STAGING ONLY. Goes through the real Supabase stack (GoTrue sign-in +
// PostgREST with the anon key), exactly like the dashboard does. Fixtures are
// seeded and removed through the CLI's postgres role (tests/rls/staging.mjs).
//
// Fixtures: Restaurant A and Restaurant B, one owner user each, 3 bookings
// each, one capacity rule, one floor zone, one floor table, one
// booking<->table assignment each.
//
// Then, authenticated as owner A, and again as an anonymous client, try to
// SELECT / UPDATE / DELETE / INSERT tenant B's bookings, settings
// (restaurants + capacity_rules) and tables (floor_zones, floor_tables,
// booking_tables). Every cross-tenant attempt must fail; every assertion is
// re-verified from outside RLS at the end.
// =============================================================================
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertStagingOnly, getAnonKey, lit, sql, stagingUrl } from './staging.mjs';

const RUN = randomUUID().slice(0, 8);
const ids = {
  restA: randomUUID(), restB: randomUUID(),
  userA: randomUUID(), userB: randomUUID(),
  zoneA: randomUUID(), zoneB: randomUUID(),
  tblA: randomUUID(), tblB: randomUUID(),
  ruleA: randomUUID(), ruleB: randomUUID(),
  bookA: [randomUUID(), randomUUID(), randomUUID()],
  bookB: [randomUUID(), randomUUID(), randomUUID()],
};
const ownerA = { email: `rls-test-owner-a-${RUN}@example.test`, password: `Pw-${randomUUID()}` };
const ownerB = { email: `rls-test-owner-b-${RUN}@example.test`, password: `Pw-${randomUUID()}` };

const clientOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
let anon;   // anonymous client (anon key, no session)
let asA;    // client signed in as owner A
let asB;    // client signed in as owner B (positive control)

const RLS_VIOLATION = /row-level security|permission denied/i;

function expectDenied(res, what) {
  // PostgREST surfaces RLS WITH CHECK failures as 42501.
  assert.ok(res.error, `${what}: expected an RLS error but the request succeeded (data=${JSON.stringify(res.data)})`);
  assert.ok(
    res.error.code === '42501' || RLS_VIOLATION.test(res.error.message),
    `${what}: expected 42501 / RLS violation, got ${res.error.code}: ${res.error.message}`
  );
}
/** For cross-reference inserts: any rejection is fine (RLS 42501 today, FK 23503 once tenant-scoped FKs exist). */
function expectAnyError(res, what) {
  assert.ok(res.error, `${what}: expected the insert to be rejected but it succeeded (data=${JSON.stringify(res.data)})`);
}
function expectNoRows(res, what) {
  assert.equal(res.error, null, `${what}: unexpected error ${res.error?.code}: ${res.error?.message}`);
  assert.deepEqual(res.data ?? [], [], `${what}: expected 0 rows, got ${JSON.stringify(res.data)}`);
}

function seedSql() {
  const bookings = (restId, list, tag) => list.map((id, i) =>
    `(${lit(id)}, ${lit(restId)}, ${lit(`Guest ${tag}${i + 1}`)}, ${lit(`+35100000${i}`)}, ${lit(`guest-${tag.toLowerCase()}${i + 1}-${RUN}@example.test`)}, 2, current_date + 7, '19:00', 'manual')`
  ).join(',\n');
  return `
    -- stale fixtures from crashed runs older than 1h
    delete from public.restaurants where slug like 'rls-test-%' and created_at < now() - interval '1 hour';
    delete from auth.users where email like 'rls-test-owner-%@example.test' and created_at < now() - interval '1 hour';

    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new, is_sso_user)
    values
      (${lit(ids.userA)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${lit(ownerA.email)},
       extensions.crypt(${lit(ownerA.password)}, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false),
      (${lit(ids.userB)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${lit(ownerB.email)},
       extensions.crypt(${lit(ownerB.password)}, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false);

    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values
      (gen_random_uuid(), ${lit(ids.userA)}, ${lit(ids.userA)}, 'email',
       jsonb_build_object('sub', ${lit(ids.userA)}, 'email', ${lit(ownerA.email)}, 'email_verified', true), now(), now(), now()),
      (gen_random_uuid(), ${lit(ids.userB)}, ${lit(ids.userB)}, 'email',
       jsonb_build_object('sub', ${lit(ids.userB)}, 'email', ${lit(ownerB.email)}, 'email_verified', true), now(), now(), now());

    insert into public.restaurants (id, name, slug, default_max_covers)
    values (${lit(ids.restA)}, 'RLS Test Restaurant A', ${lit(`rls-test-a-${RUN}`)}, 20),
           (${lit(ids.restB)}, 'RLS Test Restaurant B', ${lit(`rls-test-b-${RUN}`)}, 20);

    insert into public.owners (id, restaurant_id, email)
    values (${lit(ids.userA)}, ${lit(ids.restA)}, ${lit(ownerA.email)}),
           (${lit(ids.userB)}, ${lit(ids.restB)}, ${lit(ownerB.email)});

    insert into public.bookings (id, restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot, source)
    values ${bookings(ids.restA, ids.bookA, 'A')},
           ${bookings(ids.restB, ids.bookB, 'B')};

    insert into public.capacity_rules (id, restaurant_id, day_of_week, max_covers)
    values (${lit(ids.ruleA)}, ${lit(ids.restA)}, 5, 30), (${lit(ids.ruleB)}, ${lit(ids.restB)}, 5, 30);

    insert into public.floor_zones (id, restaurant_id, name)
    values (${lit(ids.zoneA)}, ${lit(ids.restA)}, 'Zone A'), (${lit(ids.zoneB)}, ${lit(ids.restB)}, 'Zone B');

    insert into public.floor_tables (id, restaurant_id, zone_id, name, seats, x, y, w, h)
    values (${lit(ids.tblA)}, ${lit(ids.restA)}, ${lit(ids.zoneA)}, 'T1-A', 4, 10, 10, 80, 80),
           (${lit(ids.tblB)}, ${lit(ids.restB)}, ${lit(ids.zoneB)}, 'T1-B', 4, 10, 10, 80, 80);

    insert into public.booking_tables (booking_id, table_id, restaurant_id)
    values (${lit(ids.bookA[0])}, ${lit(ids.tblA)}, ${lit(ids.restA)}),
           (${lit(ids.bookB[0])}, ${lit(ids.tblB)}, ${lit(ids.restB)});

    select 'seeded' as status;
  `;
}

function cleanupSql() {
  return `
    delete from public.restaurants where id in (${lit(ids.restA)}, ${lit(ids.restB)});
    delete from auth.users where id in (${lit(ids.userA)}, ${lit(ids.userB)});
    select 'cleaned' as status;
  `;
}

before(async () => {
  const project = assertStagingOnly();
  console.log(`  target: ${project.name} (${project.ref}) via ${stagingUrl()}`);
  const anonKey = getAnonKey();
  sql(seedSql());

  anon = createClient(stagingUrl(), anonKey, clientOpts);
  asA = createClient(stagingUrl(), anonKey, clientOpts);
  asB = createClient(stagingUrl(), anonKey, clientOpts);
  const a = await asA.auth.signInWithPassword(ownerA);
  assert.equal(a.error, null, `owner A sign-in failed: ${a.error?.message}`);
  const b = await asB.auth.signInWithPassword(ownerB);
  assert.equal(b.error, null, `owner B sign-in failed: ${b.error?.message}`);
});

after(async () => {
  try { await asA?.auth.signOut(); } catch {}
  try { await asB?.auth.signOut(); } catch {}
  sql(cleanupSql());
});

describe('positive controls (the harness is really running as the owners)', () => {
  it('owner A sees exactly their own 3 bookings and their own restaurant', async () => {
    const r = await asA.from('bookings').select('id, restaurant_id');
    assert.equal(r.error, null, r.error?.message);
    assert.equal(r.data.length, 3);
    assert.ok(r.data.every((b) => b.restaurant_id === ids.restA));
    const s = await asA.from('restaurants').select('id');
    assert.deepEqual(s.data.map((x) => x.id), [ids.restA]);
    const me = await asA.rpc('my_restaurant_id');
    assert.equal(me.data, ids.restA);
  });
  it('owner B sees exactly their own 3 bookings', async () => {
    const r = await asB.from('bookings').select('id, restaurant_id');
    assert.equal(r.data.length, 3);
    assert.ok(r.data.every((b) => b.restaurant_id === ids.restB));
  });
  it('owner A can update their own booking', async () => {
    const r = await asA.from('bookings').update({ notes: 'edited by A' }).eq('id', ids.bookA[1]).select('id');
    assert.equal(r.error, null, r.error?.message);
    assert.equal(r.data.length, 1);
  });
});

describe('owner A -> tenant B: bookings', () => {
  it('select by restaurant_id returns nothing', async () =>
    expectNoRows(await asA.from('bookings').select('*').eq('restaurant_id', ids.restB), 'select B bookings'));
  it('select by primary key returns nothing', async () =>
    expectNoRows(await asA.from('bookings').select('*').in('id', ids.bookB), 'select B bookings by id'));
  it('update affects 0 rows', async () =>
    expectNoRows(await asA.from('bookings').update({ guest_name: 'RLS-HACKED' }).eq('restaurant_id', ids.restB).select('id'), 'update B bookings'));
  it('cancel by id affects 0 rows', async () =>
    expectNoRows(await asA.from('bookings').update({ status: 'cancelled' }).eq('id', ids.bookB[0]).select('id'), 'cancel B booking'));
  it('delete affects 0 rows', async () =>
    expectNoRows(await asA.from('bookings').delete().eq('restaurant_id', ids.restB).select('id'), 'delete B bookings'));
  it('insert with restaurant_id = B is rejected', async () =>
    expectDenied(await asA.from('bookings').insert({
      restaurant_id: ids.restB, guest_name: 'RLS-HACKED', guest_phone: '0', guest_email: 'x@example.test',
      party_size: 2, date: '2030-01-01', time_slot: '20:00',
    }).select('id'), 'insert booking for B'));
  it('moving own booking into tenant B is rejected', async () => {
    const r = await asA.from('bookings').update({ restaurant_id: ids.restB }).eq('id', ids.bookA[0]).select('id');
    // Either an explicit WITH CHECK violation or 0 rows is acceptable; a moved row is not.
    if (!r.error) assert.deepEqual(r.data, [], 'booking was moved into tenant B');
    else expectDenied(r, 'move booking to B');
  });
  it('create_widget_booking RPC for B is denied', async () => {
    const r = await asA.rpc('create_widget_booking', {
      p_restaurant_id: ids.restB, p_date: '2030-01-01', p_time_slot: '20:00', p_party_size: 2,
      p_guest_name: 'RLS-HACKED', p_guest_phone: '0', p_guest_email: 'x@example.test', p_notes: null,
      p_max_covers: 100, p_guest_lang: 'en',
    });
    expectDenied(r, 'rpc create_widget_booking');
  });
});

describe('owner A -> tenant B: settings (restaurants + capacity_rules)', () => {
  it('select B restaurant returns nothing', async () =>
    expectNoRows(await asA.from('restaurants').select('*').eq('id', ids.restB), 'select B restaurant'));
  it('update B settings affects 0 rows', async () =>
    expectNoRows(await asA.from('restaurants').update({ name: 'RLS-HACKED', default_max_covers: 0 }).eq('id', ids.restB).select('id'), 'update B restaurant'));
  it('delete B restaurant affects 0 rows', async () =>
    expectNoRows(await asA.from('restaurants').delete().eq('id', ids.restB).select('id'), 'delete B restaurant'));
  it('insert a new restaurant is rejected', async () =>
    expectDenied(await asA.from('restaurants').insert({ name: 'RLS-HACKED', slug: `rls-hacked-${RUN}` }).select('id'), 'insert restaurant'));
  it('select B capacity rules returns nothing', async () =>
    expectNoRows(await asA.from('capacity_rules').select('*').eq('restaurant_id', ids.restB), 'select B rules'));
  it('update B capacity rules affects 0 rows', async () =>
    expectNoRows(await asA.from('capacity_rules').update({ max_covers: 999 }).eq('restaurant_id', ids.restB).select('id'), 'update B rules'));
  it('delete B capacity rule affects 0 rows', async () =>
    expectNoRows(await asA.from('capacity_rules').delete().eq('id', ids.ruleB).select('id'), 'delete B rule'));
  it('insert capacity rule for B is rejected', async () =>
    expectDenied(await asA.from('capacity_rules').insert({ restaurant_id: ids.restB, day_of_week: 6, max_covers: 999 }).select('id'), 'insert rule for B'));
  it('select B owners returns nothing', async () =>
    expectNoRows(await asA.from('owners').select('*').eq('restaurant_id', ids.restB), 'select B owners'));
  it('re-pointing own membership to B affects 0 rows', async () =>
    expectNoRows(await asA.from('owners').update({ restaurant_id: ids.restB }).eq('id', ids.userA).select('id'), 'update own owner row'));
});

describe('owner A -> tenant B: tables (floor_zones, floor_tables, booking_tables)', () => {
  it('select B zones returns nothing', async () =>
    expectNoRows(await asA.from('floor_zones').select('*').eq('restaurant_id', ids.restB), 'select B zones'));
  it('update B zone affects 0 rows', async () =>
    expectNoRows(await asA.from('floor_zones').update({ name: 'RLS-HACKED' }).eq('id', ids.zoneB).select('id'), 'update B zone'));
  it('delete B zone affects 0 rows', async () =>
    expectNoRows(await asA.from('floor_zones').delete().eq('id', ids.zoneB).select('id'), 'delete B zone'));
  it('insert zone for B is rejected', async () =>
    expectDenied(await asA.from('floor_zones').insert({ restaurant_id: ids.restB, name: 'RLS-HACKED' }).select('id'), 'insert zone for B'));

  it('select B tables returns nothing', async () =>
    expectNoRows(await asA.from('floor_tables').select('*').eq('restaurant_id', ids.restB), 'select B tables'));
  it('select B table by primary key returns nothing', async () =>
    expectNoRows(await asA.from('floor_tables').select('*').eq('id', ids.tblB), 'select B table by id'));
  it('update B tables affects 0 rows', async () =>
    expectNoRows(await asA.from('floor_tables').update({ name: 'RLS-HACKED', seats: 1 }).eq('restaurant_id', ids.restB).select('id'), 'update B tables'));
  it('delete B table affects 0 rows', async () =>
    expectNoRows(await asA.from('floor_tables').delete().eq('id', ids.tblB).select('id'), 'delete B table'));
  it('insert table for B is rejected', async () =>
    expectDenied(await asA.from('floor_tables').insert({
      restaurant_id: ids.restB, zone_id: ids.zoneB, name: 'RLS-HACKED', seats: 2, x: 0, y: 0, w: 10, h: 10,
    }).select('id'), 'insert table for B'));
  it('insert own table into B zone (zone_id = B) is rejected', async () =>
    expectAnyError(await asA.from('floor_tables').insert({
      restaurant_id: ids.restA, zone_id: ids.zoneB, name: 'RLS-HACKED', seats: 2, x: 0, y: 0, w: 10, h: 10,
    }).select('id'), 'insert A table in B zone'));

  it('select B assignments returns nothing', async () =>
    expectNoRows(await asA.from('booking_tables').select('*').eq('restaurant_id', ids.restB), 'select B assignments'));
  it('delete B assignments affects 0 rows', async () =>
    expectNoRows(await asA.from('booking_tables').delete().eq('restaurant_id', ids.restB).select('booking_id'), 'delete B assignments'));
  it('insert assignment for B is rejected', async () =>
    expectDenied(await asA.from('booking_tables').insert({ booking_id: ids.bookB[1], table_id: ids.tblB, restaurant_id: ids.restB }).select('booking_id'), 'insert assignment for B'));
  it('assigning own booking to B table (table_id = B) is rejected', async () =>
    expectAnyError(await asA.from('booking_tables').insert({ booking_id: ids.bookA[1], table_id: ids.tblB, restaurant_id: ids.restA }).select('booking_id'), 'assign A booking to B table'));
  it('assigning B booking to own table (booking_id = B) is rejected', async () =>
    expectAnyError(await asA.from('booking_tables').insert({ booking_id: ids.bookB[2], table_id: ids.tblA, restaurant_id: ids.restA }).select('booking_id'), 'assign B booking to A table'));
});

describe('anonymous -> any tenant', () => {
  for (const t of ['bookings', 'restaurants', 'owners', 'capacity_rules', 'floor_zones', 'floor_tables', 'floor_elements', 'booking_tables']) {
    it(`select ${t} returns nothing`, async () => expectNoRows(await anon.from(t).select('*').limit(50), `anon select ${t}`));
  }
  it('update bookings affects 0 rows', async () =>
    expectNoRows(await anon.from('bookings').update({ guest_name: 'RLS-HACKED' }).in('restaurant_id', [ids.restA, ids.restB]).select('id'), 'anon update bookings'));
  it('update restaurants affects 0 rows', async () =>
    expectNoRows(await anon.from('restaurants').update({ name: 'RLS-HACKED' }).in('id', [ids.restA, ids.restB]).select('id'), 'anon update restaurants'));
  it('update floor_tables affects 0 rows', async () =>
    expectNoRows(await anon.from('floor_tables').update({ name: 'RLS-HACKED' }).in('restaurant_id', [ids.restA, ids.restB]).select('id'), 'anon update tables'));
  it('delete bookings affects 0 rows', async () =>
    expectNoRows(await anon.from('bookings').delete().in('restaurant_id', [ids.restA, ids.restB]).select('id'), 'anon delete bookings'));
  it('delete restaurants affects 0 rows', async () =>
    expectNoRows(await anon.from('restaurants').delete().in('id', [ids.restA, ids.restB]).select('id'), 'anon delete restaurants'));
  it('delete floor_tables affects 0 rows', async () =>
    expectNoRows(await anon.from('floor_tables').delete().in('restaurant_id', [ids.restA, ids.restB]).select('id'), 'anon delete tables'));
  it('insert booking is rejected', async () =>
    expectDenied(await anon.from('bookings').insert({
      restaurant_id: ids.restB, guest_name: 'RLS-HACKED', guest_phone: '0', guest_email: 'x@example.test',
      party_size: 2, date: '2030-01-01', time_slot: '20:00',
    }).select('id'), 'anon insert booking'));
  it('insert restaurant is rejected', async () =>
    expectDenied(await anon.from('restaurants').insert({ name: 'RLS-HACKED', slug: `rls-hacked-anon-${RUN}` }).select('id'), 'anon insert restaurant'));
  it('insert floor table is rejected', async () =>
    expectDenied(await anon.from('floor_tables').insert({
      restaurant_id: ids.restB, zone_id: ids.zoneB, name: 'RLS-HACKED', seats: 2, x: 0, y: 0, w: 10, h: 10,
    }).select('id'), 'anon insert table'));
  it('my_restaurant_id RPC yields nothing (null or denied)', async () => {
    // Every RLS policy evaluates my_restaurant_id(), so anon may be allowed to call it; it must then be null.
    const r = await anon.rpc('my_restaurant_id');
    if (r.error) expectDenied(r, 'anon rpc my_restaurant_id');
    else assert.equal(r.data, null, 'anon resolved a restaurant id');
  });
  it('create_widget_booking RPC is denied', async () =>
    expectDenied(await anon.rpc('create_widget_booking', {
      p_restaurant_id: ids.restB, p_date: '2030-01-01', p_time_slot: '20:00', p_party_size: 2,
      p_guest_name: 'RLS-HACKED', p_guest_phone: '0', p_guest_email: 'x@example.test', p_notes: null,
      p_max_covers: 100, p_guest_lang: 'en',
    }), 'anon rpc create_widget_booking'));
});

describe('verification from outside RLS (postgres): tenant B is untouched', () => {
  it('B data is intact and nothing was written on B\'s behalf', () => {
    const [row] = sql(`
      select
        (select count(*) from public.bookings where restaurant_id = ${lit(ids.restB)} and status = 'confirmed' and guest_name like 'Guest B%') as b_bookings_intact,
        (select count(*) from public.bookings where restaurant_id = ${lit(ids.restB)}) as b_bookings_total,
        (select count(*) from public.bookings where restaurant_id = ${lit(ids.restA)}) as a_bookings_total,
        (select count(*) from public.restaurants where id = ${lit(ids.restB)} and name = 'RLS Test Restaurant B' and default_max_covers = 20) as b_settings_intact,
        (select count(*) from public.restaurants where name = 'RLS-HACKED' or slug like 'rls-hacked-%') as hacked_restaurants,
        (select count(*) from public.owners where id = ${lit(ids.userA)} and restaurant_id = ${lit(ids.restA)}) as a_membership_intact,
        (select count(*) from public.capacity_rules where restaurant_id = ${lit(ids.restB)} and max_covers = 30) as b_rules_intact,
        (select count(*) from public.capacity_rules where restaurant_id = ${lit(ids.restB)}) as b_rules_total,
        (select count(*) from public.floor_zones where restaurant_id = ${lit(ids.restB)} and name = 'Zone B') as b_zones_intact,
        (select count(*) from public.floor_tables where restaurant_id = ${lit(ids.restB)} and name = 'T1-B' and seats = 4) as b_tables_intact,
        (select count(*) from public.floor_tables where zone_id = ${lit(ids.zoneB)}) as tables_in_b_zone,
        (select count(*) from public.booking_tables where table_id = ${lit(ids.tblB)} or booking_id in (${ids.bookB.map(lit).join(',')})) as rows_referencing_b
    `);
    assert.equal(Number(row.b_bookings_intact), 3, 'B bookings modified');
    assert.equal(Number(row.b_bookings_total), 3, 'rows added to B bookings');
    assert.equal(Number(row.a_bookings_total), 3, 'A bookings moved');
    assert.equal(Number(row.b_settings_intact), 1, 'B settings modified');
    assert.equal(Number(row.hacked_restaurants), 0, 'a restaurant was inserted');
    assert.equal(Number(row.a_membership_intact), 1, 'A membership re-pointed');
    assert.equal(Number(row.b_rules_intact), 1, 'B rules modified');
    assert.equal(Number(row.b_rules_total), 1, 'rule inserted for B');
    assert.equal(Number(row.b_zones_intact), 1, 'B zone modified');
    assert.equal(Number(row.b_tables_intact), 1, 'B table modified');
    assert.equal(Number(row.tables_in_b_zone), 1, 'a foreign table was placed in B\'s zone');
    assert.equal(Number(row.rows_referencing_b), 1, 'a foreign booking_tables row references B\'s objects');
  });
});
