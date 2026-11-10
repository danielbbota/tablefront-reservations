import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, corsPreflight } from '@/lib/cors';
import { asLang } from '@/lib/i18n';
import {
  APPOINTMENT_HORIZON_DAYS,
  BOOKING_HORIZON_DAYS,
  MAX_PARTY_SIZE,
  STAY_HORIZON_DAYS,
  STAY_MAX_NIGHTS,
  businessTypeOf,
  currencyOf,
  type Restaurant,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/public/config?restaurant=<id>
 * Widget bootstrap: name, product, language and booking limits.
 */
export async function GET(req: NextRequest) {
  const restaurantId = req.nextUrl.searchParams.get('restaurant');
  if (!restaurantId) return corsJson({ error: 'restaurant is required' }, 400);

  // select('*'): works whether or not migration 0006 has been applied.
  const { data: restaurant } = await createAdminClient()
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single<Restaurant>();

  if (!restaurant) return corsJson({ error: 'Restaurant not found' }, 404);

  const businessType = businessTypeOf(restaurant);
  const base = {
    restaurant: { id: restaurant.id, name: restaurant.name },
    businessType,
    language: asLang(restaurant.language),
    currency: currencyOf(restaurant),
  };

  if (businessType === 'stays') {
    return corsJson({
      ...base,
      horizonDays: STAY_HORIZON_DAYS,
      maxNights: STAY_MAX_NIGHTS,
      checkInTime: (restaurant.check_in_time ?? '15:00').slice(0, 5),
      checkOutTime: (restaurant.check_out_time ?? '11:00').slice(0, 5),
    });
  }
  if (businessType === 'appointments') {
    return corsJson({ ...base, horizonDays: APPOINTMENT_HORIZON_DAYS });
  }

  return corsJson({
    ...base,
    maxPartySize: MAX_PARTY_SIZE,
    horizonDays: BOOKING_HORIZON_DAYS,
  });
}
