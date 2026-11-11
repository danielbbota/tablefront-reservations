import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Appointment, Staff, StaffService, StaffTimeOff } from '../types';

export type DayContext = {
  staff: Staff[];
  staffServices: StaffService[];
  appointments: Appointment[];
  timeOff: StaffTimeOff[];
};

/**
 * Everything slot availability needs for one business and date. Every query
 * is scoped by restaurant_id explicitly, so it is safe with the service-role
 * client (public API) as well as under an owner's RLS session.
 */
export async function loadDayContext(
  supabase: SupabaseClient,
  businessId: string,
  date: string
): Promise<DayContext> {
  const [{ data: staff }, { data: staffServices }, { data: appointments }, { data: timeOff }] =
    await Promise.all([
      supabase
        .from('staff')
        .select('*')
        .eq('restaurant_id', businessId)
        .order('sort')
        .order('name')
        .returns<Staff[]>(),
      supabase
        .from('staff_services')
        .select('*')
        .eq('restaurant_id', businessId)
        .returns<StaffService[]>(),
      supabase
        .from('appointments')
        .select('*')
        .eq('restaurant_id', businessId)
        .eq('date', date)
        .neq('status', 'cancelled')
        .returns<Appointment[]>(),
      supabase
        .from('staff_time_off')
        .select('*')
        .eq('restaurant_id', businessId)
        .eq('date', date)
        .returns<StaffTimeOff[]>(),
    ]);
  return {
    staff: staff ?? [],
    staffServices: staffServices ?? [],
    appointments: appointments ?? [],
    timeOff: timeOff ?? [],
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a YYYY-MM-DD string that is a real calendar date. */
export function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Last bookable date: `days` after today (both YYYY-MM-DD). */
export function horizonDate(today: string, days: number): string {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
