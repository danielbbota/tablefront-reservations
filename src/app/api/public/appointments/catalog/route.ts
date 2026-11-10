import { groupByCategory } from '@/lib/appointments/catalog';
import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsJson, corsPreflight } from '@/lib/cors';
import { getPaymentSetup, paymentTerms } from '@/lib/payments/checkout';
import {
  businessTypeOf,
  currencyOf,
  type Restaurant,
  type Service,
  type Staff,
  type StaffService,
} from '@/lib/types';

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/public/appointments/catalog?restaurant=<id>
 * What a guest can book: the active services (with what would be charged
 * online, if anything) and the active professionals who perform them.
 */
export async function GET(req: NextRequest) {
  const businessId = req.nextUrl.searchParams.get('restaurant');
  if (!businessId) return corsJson({ error: 'restaurant is required' }, 400);

  const supabase = createAdminClient();
  const { data: business } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', businessId)
    .single<Restaurant>();
  if (!business || businessTypeOf(business) !== 'appointments') {
    return corsJson({ error: 'Business not found' }, 404);
  }

  const [{ data: services }, { data: staff }, { data: links }, setup] = await Promise.all([
    supabase
      .from('services')
      .select('*')
      .eq('restaurant_id', business.id)
      .eq('active', true)
      .order('sort')
      .order('name')
      .returns<Service[]>(),
    supabase
      .from('staff')
      .select('*')
      .eq('restaurant_id', business.id)
      .eq('active', true)
      .order('sort')
      .order('name')
      .returns<Staff[]>(),
    supabase
      .from('staff_services')
      .select('*')
      .eq('restaurant_id', business.id)
      .returns<StaffService[]>(),
    getPaymentSetup(supabase, business),
  ]);

  const activeStaff = new Set((staff ?? []).map((s) => s.id));
  const activeServices = new Set((services ?? []).map((s) => s.id));
  const usable = (links ?? []).filter(
    (l) => activeStaff.has(l.staff_id) && activeServices.has(l.service_id)
  );
  // A service nobody performs cannot be booked: leave it out.
  const offered = new Set(usable.map((l) => l.service_id));

  return corsJson({
    business: { id: business.id, name: business.name },
    currency: currencyOf(business),
    paymentMode: setup ? setup.mode : 'none',
    services: groupByCategory((services ?? []).filter((s) => offered.has(s.id))).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
      durationMinutes: s.duration_minutes,
      priceCents: s.price_cents,
      dueNowCents: paymentTerms(s.price_cents, setup).amountDueCents,
    })),
    staff: (staff ?? [])
      .map((s) => ({
        id: s.id,
        name: s.name,
        title: s.title,
        serviceIds: usable.filter((l) => l.staff_id === s.id).map((l) => l.service_id),
      }))
      .filter((s) => s.serviceIds.length > 0),
  });
}
