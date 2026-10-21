import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { OperatingHours, Restaurant } from '@/lib/types';

/** Service-role client for seeding and verifying fixtures on STAGING (set up by setup.ts). */
export function adminClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anon-key client (what the widget / dashboard browser code uses). */
export function anonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const OPEN_ALL_WEEK: OperatingHours = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '12:00', close: '22:00', closed: false }])
);

export type Fixture = {
  run: string;
  restaurant: Restaurant;
  cleanup: () => Promise<void>;
};

/**
 * Create a throwaway restaurant on staging. Slug prefix `test-int-` marks it;
 * cleanup deletes it (bookings, rules, floor rows cascade).
 */
export async function createFixtureRestaurant(overrides: Partial<Restaurant> = {}): Promise<Fixture> {
  const supabase = adminClient();
  const run = randomUUID().slice(0, 8);

  // Sweep leftovers from crashed runs older than one hour.
  await supabase
    .from('restaurants')
    .delete()
    .like('slug', 'test-int-%')
    .lt('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

  const { data, error } = await supabase
    .from('restaurants')
    .insert({
      name: `Integration Test ${run}`,
      slug: `test-int-${run}`,
      timezone: 'Europe/Lisbon',
      slot_interval_minutes: 30,
      operating_hours: OPEN_ALL_WEEK,
      default_max_covers: 24,
      language: 'en',
      turn_time_minutes: 90,
      brand: {},
      ...overrides,
    })
    .select('*')
    .single<Restaurant>();
  if (error || !data) throw new Error(`could not seed fixture restaurant: ${error?.message}`);

  return {
    run,
    restaurant: data,
    cleanup: async () => {
      await supabase.from('restaurants').delete().eq('id', data.id);
    },
  };
}

export type OwnerFixture = {
  userId: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
};

/**
 * Create a throwaway owner (Auth user + `owners` row) for a fixture restaurant
 * on staging. Email prefix `int-owner-` marks it; cleanup deletes the user
 * (the `owners` row cascades with the restaurant).
 */
export async function createFixtureOwner(restaurantId: string, run: string): Promise<OwnerFixture> {
  const supabase = adminClient();

  // Sweep owner users left behind by crashed runs older than one hour.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) {
    if (/^int-owner-.*@example\.test$/.test(u.email ?? '') && u.created_at < cutoff) {
      await supabase.auth.admin.deleteUser(u.id);
    }
  }

  const email = `int-owner-${run}@example.test`;
  const password = `Int-${randomUUID()}`;
  const { data: created, error: userErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw new Error(`could not create fixture owner: ${userErr?.message}`);

  const { error: ownerErr } = await supabase
    .from('owners')
    .insert({ id: created.user.id, restaurant_id: restaurantId, email });
  if (ownerErr) {
    await supabase.auth.admin.deleteUser(created.user.id);
    throw new Error(`could not link fixture owner: ${ownerErr.message}`);
  }

  return {
    userId: created.user.id,
    email,
    password,
    cleanup: async () => {
      await supabase.auth.admin.deleteUser(created.user.id);
    },
  };
}

/** Anon-key client signed in as a fixture owner: what the dashboard's cookie client is, under RLS. */
export async function ownerClient(owner: Pick<OwnerFixture, 'email' | 'password'>): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
  if (error) throw new Error(`could not sign in fixture owner: ${error.message}`);
  return client;
}

/** YYYY-MM-DD for `daysFromNow` days ahead, in UTC (fixtures use dates well inside the horizon). */
export function isoDateFromNow(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

export function getRequest(path: string, params: Record<string, string> = {}): NextRequest {
  const url = new URL(path, 'http://localhost:3100');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

export function postJson(path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3100'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
