import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { syncFeeds } from './sync';

/**
 * Background upkeep, run from cron: pull every channel calendar (oldest
 * first) and tidy away payment holds that ran out. Service-role client.
 */
export async function runChannelHousekeeping(supabase: SupabaseClient) {
  const results = await syncFeeds(supabase, {}, 0, 200);

  // Unpaid holds already stopped blocking dates / slots when they expired;
  // flipping them to cancelled just keeps the lists tidy.
  const now = new Date().toISOString();
  for (const table of ['stay_reservations', 'appointments'] as const) {
    await supabase
      .from(table)
      .update({ status: 'cancelled', payment_status: 'none', hold_expires_at: null })
      .eq('status', 'pending_payment')
      .lt('hold_expires_at', now);
  }

  return {
    feeds: results.length,
    failed: results.filter((r) => !r.ok).map((r) => r.feedId),
    imported: results.reduce((n, r) => n + r.imported, 0),
    updated: results.reduce((n, r) => n + r.updated, 0),
    cancelled: results.reduce((n, r) => n + r.cancelled, 0),
  };
}
