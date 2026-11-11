import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { createServerSupabase } from './supabase/server';
import { businessTypeOf, type BusinessType, type Restaurant } from './types';

/** Where each product's dashboard starts. */
export const HOME: Record<BusinessType, string> = {
  restaurant: '/',
  stays: '/stays',
  appointments: '/agenda',
};

/** The logged-in owner's business, read under RLS. */
export async function loadBusiness() {
  const supabase = await createServerSupabase();
  const { data: business } = await supabase.from('restaurants').select('*').single<Restaurant>();
  return { supabase, business };
}

/**
 * For dashboard pages that belong to one product: an owner on another product
 * is sent to their own home instead of seeing a screen that makes no sense
 * for them.
 */
export async function requireBusiness(type: BusinessType) {
  const { supabase, business } = await loadBusiness();
  if (!business) notFound();
  const actual = businessTypeOf(business);
  if (actual !== type) redirect(HOME[actual]);
  return { supabase, business };
}

/** Send non-restaurant owners away from a restaurant-only page. */
export function leaveIfNotRestaurant(business: Pick<Restaurant, 'business_type'> | null | undefined) {
  const actual = businessTypeOf(business);
  if (actual !== 'restaurant') redirect(HOME[actual]);
}
