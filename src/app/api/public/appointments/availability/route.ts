import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { nowInTimezone } from '@/lib/availability';
import { corsJson, corsPreflight } from '@/lib/cors';
import { horizonDate, isRealDate, loadDayContext, UUID_RE } from '@/lib/appointments/data';
import { availableSlots } from '@/lib/appointments/slots';
import {
  APPOINTMENT_HORIZON_DAYS,
  businessTypeOf,
  type Restaurant,
  type Service,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/public/appointments/availability?restaurant=<id>&service=<id>&staff=any|<id>&date=YYYY-MM-DD
 * Free start times for a service on a date, for one professional or any.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const businessId = q.get('restaurant');
  const serviceId = q.get('service') ?? '';
  const staffId = q.get('staff') || 'any';
  const date = q.get('date');

  if (!businessId || !UUID_RE.test(serviceId) || !isRealDate(date)) {
    return corsJson({ error: 'restaurant, service and date (YYYY-MM-DD) are required' }, 400);
  }
  if (staffId !== 'any' && !UUID_RE.test(staffId)) {
    return corsJson({ error: 'Invalid professional' }, 400);
  }

  const supabase = createAdminClient();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', businessId)
    .single<Restaurant>();
  if (!business || businessTypeOf(business) !== 'appointments') {
    return corsJson({ error: 'Business not found' }, 404);
  }

  const clock = nowInTimezone(business.timezone);
  if (date > horizonDate(clock.date, APPOINTMENT_HORIZON_DAYS)) {
    return corsJson({ error: 'Date is beyond the booking window' }, 400);
  }

  const { data: service } = await supabase
    .from('services')
    .select('*')
    .eq('id', serviceId)
    .eq('restaurant_id', business.id)
    .eq('active', true)
    .maybeSingle<Service>();
  if (!service) return corsJson({ error: 'Service not found' }, 404);

  const ctx = await loadDayContext(supabase, business.id, date);
  const slots = availableSlots({ business, service, ...ctx, date, staffId, clock });

  return corsJson({
    date,
    service: { id: service.id, durationMinutes: service.duration_minutes },
    slots: slots.map((s) => ({ time: s.time })),
  });
}
