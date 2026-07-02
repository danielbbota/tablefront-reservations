import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, corsPreflight } from '@/lib/cors';
import { asLang } from '@/lib/i18n';
import { BOOKING_HORIZON_DAYS, MAX_PARTY_SIZE, type Restaurant } from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/public/config?restaurant=<id>
 * Widget bootstrap: name, language and booking limits.
 */
export async function GET(req: NextRequest) {
  const restaurantId = req.nextUrl.searchParams.get('restaurant');
  if (!restaurantId) return corsJson({ error: 'restaurant is required' }, 400);

  const { data: restaurant } = await createAdminClient()
    .from('restaurants')
    .select('id, name, language')
    .eq('id', restaurantId)
    .single<Pick<Restaurant, 'id' | 'name' | 'language'>>();

  if (!restaurant) return corsJson({ error: 'Restaurant not found' }, 404);

  return corsJson({
    restaurant: { id: restaurant.id, name: restaurant.name },
    language: asLang(restaurant.language),
    maxPartySize: MAX_PARTY_SIZE,
    horizonDays: BOOKING_HORIZON_DAYS,
  });
}
