import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nowInTimezone } from '../availability';
import type { Restaurant, StayIcalFeed, StayReservation } from '../types';
import { IcalParseError, parseIcal, planSync } from './ical';

/**
 * Pulls channel calendars (Airbnb, Booking.com, Vrbo) into stay_reservations.
 * Always runs with the service-role client: it is called from cron, from the
 * public booking API and from owner actions alike, and scopes every query by
 * feed / unit / restaurant id itself.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

export class FeedUrlError extends Error {}

/**
 * Owners paste these URLs, and the server fetches them: only allow public
 * https hosts so a feed can never be pointed at something internal.
 */
export function assertSafeFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedUrlError('The calendar address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new FeedUrlError('The calendar address must start with https://');
  if (url.username || url.password) throw new FeedUrlError('The calendar address must not contain credentials.');
  const host = url.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  if (
    isIp ||
    host === 'localhost' ||
    !host.includes('.') ||
    /\.(local|localhost|internal|lan|home|corp|test|invalid)$/.test(host)
  ) {
    throw new FeedUrlError('The calendar address must be a public website address.');
  }
  return url;
}

/** Fetch a feed, following a few redirects by hand so every hop is re-checked. */
export async function fetchFeed(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url = assertSafeFeedUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'TableFront-CalendarSync/1.0', Accept: 'text/calendar, text/plain, */*' },
      cache: 'no-store',
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`Redirect without a location (HTTP ${res.status}).`);
      url = assertSafeFeedUrl(new URL(next, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The channel answered HTTP ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('The calendar is too large.');
    return text;
  }
  throw new Error('Too many redirects.');
}

export type FeedSyncResult = {
  feedId: string;
  ok: boolean;
  imported: number;
  updated: number;
  cancelled: number;
  error?: string;
};

/** Sync one feed. Never throws: the outcome is recorded on the feed row. */
export async function syncFeed(
  supabase: SupabaseClient,
  feed: StayIcalFeed,
  fetchImpl: typeof fetch = fetch
): Promise<FeedSyncResult> {
  const result: FeedSyncResult = { feedId: feed.id, ok: false, imported: 0, updated: 0, cancelled: 0 };
  const finish = async (error?: string) => {
    await supabase
      .from('stay_ical_feeds')
      .update({
        last_synced_at: new Date().toISOString(),
        last_status: error ? 'error' : 'ok',
        last_error: error ? error.slice(0, 300) : null,
      })
      .eq('id', feed.id);
    result.ok = !error;
    if (error) result.error = error;
    return result;
  };

  let events;
  try {
    events = parseIcal(await fetchFeed(feed.url, fetchImpl));
  } catch (err) {
    const message =
      err instanceof FeedUrlError || err instanceof IcalParseError
        ? err.message
        : err instanceof Error && err.name === 'TimeoutError'
          ? 'The channel did not answer in time.'
          : err instanceof Error
            ? err.message
            : 'Could not read the calendar.';
    return finish(message);
  }

  const [{ data: business }, { data: unitRows, error: readErr }] = await Promise.all([
    supabase
      .from('restaurants')
      .select('timezone')
      .eq('id', feed.restaurant_id)
      .maybeSingle<Pick<Restaurant, 'timezone'>>(),
    supabase
      .from('stay_reservations')
      .select('id, feed_id, external_uid, check_in, check_out, status, hold_expires_at')
      .eq('unit_id', feed.unit_id)
      .returns<
        Pick<
          StayReservation,
          'id' | 'feed_id' | 'external_uid' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'
        >[]
      >(),
  ]);
  if (readErr) return finish(`Could not read reservations: ${readErr.message}`);

  const today = nowInTimezone(business?.timezone ?? 'UTC').date;
  const mine = (unitRows ?? []).filter((r) => r.feed_id === feed.id);
  const others = (unitRows ?? []).filter((r) => r.feed_id !== feed.id);
  const plan = planSync(feed.channel, events, mine, others, today);

  if (plan.inserts.length) {
    const { error } = await supabase.from('stay_reservations').insert(
      plan.inserts.map((ins) => ({
        restaurant_id: feed.restaurant_id,
        unit_id: feed.unit_id,
        feed_id: feed.id,
        source: feed.channel,
        status: 'confirmed',
        guests: 1,
        ...ins,
      }))
    );
    if (error) return finish(`Could not import reservations: ${error.message}`);
    result.imported = plan.inserts.length;
  }
  for (const upd of plan.updates) {
    const { error } = await supabase
      .from('stay_reservations')
      .update({ check_in: upd.check_in, check_out: upd.check_out, status: 'confirmed' })
      .eq('id', upd.id)
      .eq('feed_id', feed.id);
    if (error) return finish(`Could not update a reservation: ${error.message}`);
    result.updated++;
  }
  if (plan.cancels.length) {
    const { error } = await supabase
      .from('stay_reservations')
      .update({ status: 'cancelled' })
      .in('id', plan.cancels)
      .eq('feed_id', feed.id);
    if (error) return finish(`Could not cancel reservations: ${error.message}`);
    result.cancelled = plan.cancels.length;
  }

  return finish();
}

export type SyncScope = { restaurantId?: string; unitId?: string };

/**
 * Sync every feed in scope that has not been synced for `maxAgeMinutes`
 * (0 = all of them). Feeds run in parallel; one failing never stops the rest.
 */
export async function syncFeeds(
  supabase: SupabaseClient,
  scope: SyncScope,
  maxAgeMinutes = 0,
  limit = 50
): Promise<FeedSyncResult[]> {
  let query = supabase.from('stay_ical_feeds').select('*').order('last_synced_at', {
    ascending: true,
    nullsFirst: true,
  });
  if (scope.restaurantId) query = query.eq('restaurant_id', scope.restaurantId);
  if (scope.unitId) query = query.eq('unit_id', scope.unitId);
  const { data: feeds } = await query.limit(limit).returns<StayIcalFeed[]>();

  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  const due = (feeds ?? []).filter(
    (f) => maxAgeMinutes <= 0 || !f.last_synced_at || Date.parse(f.last_synced_at) < cutoff
  );
  return Promise.all(due.map((f) => syncFeed(supabase, f)));
}

/** True when some feed in the list is older than `maxAgeMinutes` (or never synced). */
export function anyFeedStale(
  feeds: Pick<StayIcalFeed, 'last_synced_at'>[],
  maxAgeMinutes: number,
  now: Date = new Date()
): boolean {
  const cutoff = now.getTime() - maxAgeMinutes * 60_000;
  return feeds.some((f) => !f.last_synced_at || Date.parse(f.last_synced_at) < cutoff);
}
