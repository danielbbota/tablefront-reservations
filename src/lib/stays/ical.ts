import type { StayChannel, StayReservation } from '../types';
import { addDays, isIsoDate } from './dates';
import { isLive } from './availability';

/**
 * iCalendar (RFC 5545) reading and writing for channel sync. Airbnb,
 * Booking.com and Vrbo exchange availability as all-day VEVENTs: DTSTART is
 * the arrival date, DTEND the departure date (exclusive), exactly our
 * check_in / check_out.
 */

/** Marks events that came out of TableFront, so we never import our own feed. */
export const UID_SUFFIX = '@tablefront';

export type IcalEvent = {
  uid: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, exclusive
  summary: string;
  description: string;
  status: string; // CONFIRMED | TENTATIVE | CANCELLED | ''
};

export class IcalParseError extends Error {}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

/** "20260712" or "20260712T150000Z" → "2026-07-12". Null when unparseable. */
function parseIcalDate(value: string): string | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * Parse a calendar into its events. Throws IcalParseError when the text is
 * not a calendar at all (an HTML error page, an empty body): the caller must
 * then leave existing reservations alone rather than treat it as "no events".
 * Events without a usable UID or start date are skipped.
 */
export function parseIcal(text: string): IcalEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new IcalParseError('Not an iCalendar file (BEGIN:VCALENDAR is missing).');
  }

  // Unfold: a line starting with a space or tab continues the previous one.
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');

  const events: IcalEvent[] = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        const start = parseIcalDate(current.DTSTART ?? '');
        const uid = (current.UID ?? '').trim();
        if (start && uid) {
          let end = parseIcalDate(current.DTEND ?? '');
          if (!end || end <= start) end = addDays(start, 1);
          events.push({
            uid,
            start,
            end,
            summary: unescapeText(current.SUMMARY ?? ''),
            description: unescapeText(current.DESCRIPTION ?? ''),
            status: (current.STATUS ?? '').trim().toUpperCase(),
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    // "DTSTART;VALUE=DATE" → "DTSTART"
    const name = line.slice(0, colon).split(';')[0].trim().toUpperCase();
    if (name && !(name in current)) current[name] = line.slice(colon + 1);
  }

  return events;
}

export type ChannelEventInfo = {
  /** What we store as guest_name: the channel's own wording, never invented. */
  label: string;
  /** Reservation code or link the channel exposes, if any. */
  externalRef: string | null;
  /** True when the channel says the dates are closed but not that a guest booked. */
  blockOnly: boolean;
  notes: string | null;
};

/**
 * What a channel's event tells us. iCal carries no guest name, email or
 * price for any of them. Airbnb separates real reservations ("Reserved", with
 * the reservation link and the last 4 phone digits) from dates that are merely
 * unavailable; Booking.com labels everything "CLOSED - Not available", so
 * every Booking.com event has to be treated as a possible guest.
 */
export function describeChannelEvent(channel: StayChannel, ev: IcalEvent): ChannelEventInfo {
  const summary = ev.summary || 'Reserved';

  if (channel === 'airbnb') {
    const url = ev.description.match(/https?:\/\/\S*airbnb\.\S*\/reservations\/details\/([A-Z0-9]+)/i);
    const phone = ev.description.match(/Last 4 Digits\)?\s*:\s*(\d{4})/i);
    const blockOnly = /not available/i.test(summary) && !url;
    return {
      label: url ? `Airbnb ${url[1].toUpperCase()}` : summary,
      externalRef: url ? url[0] : null,
      blockOnly,
      notes: phone ? `Airbnb · tel. …${phone[1]}` : null,
    };
  }

  return { label: summary, externalRef: null, blockOnly: false, notes: null };
}

// ---------------------------------------------------------------------------
// Sync planning (pure): turn a parsed feed into database changes.
// ---------------------------------------------------------------------------

type ExistingRes = Pick<
  StayReservation,
  'id' | 'external_uid' | 'check_in' | 'check_out' | 'status' | 'hold_expires_at'
>;
type OtherRes = Pick<StayReservation, 'check_in' | 'check_out' | 'status' | 'hold_expires_at'>;

export type SyncPlan = {
  inserts: {
    external_uid: string;
    check_in: string;
    check_out: string;
    guest_name: string;
    external_ref: string | null;
    notes: string | null;
  }[];
  updates: { id: string; check_in: string; check_out: string }[];
  cancels: string[];
  skipped: number;
};

/**
 * Decide what one feed's latest contents mean for the reservations we hold
 * from that feed.
 *
 *  - new event              → import it as a confirmed channel reservation
 *  - known event, new dates → move it (and revive it if we had cancelled it)
 *  - event gone / CANCELLED → cancel our copy, if the stay is not over yet
 *
 * Skipped on purpose: events that ended before today, our own exported
 * events, and "unavailable" markers (no guest) on nights that another live
 * reservation of the unit already covers. That last case is how a channel
 * echoes a calendar it imported from us; a real guest booking is never
 * skipped, even when it overlaps: that is a double booking the owner must see.
 */
export function planSync(
  channel: StayChannel,
  events: IcalEvent[],
  existing: ExistingRes[],
  otherLiveOnUnit: OtherRes[],
  today: string,
  now: Date = new Date()
): SyncPlan {
  const plan: SyncPlan = { inserts: [], updates: [], cancels: [], skipped: 0 };
  const byUid = new Map(existing.filter((r) => r.external_uid).map((r) => [r.external_uid!, r]));
  const seen = new Set<string>();

  for (const ev of events) {
    if (ev.uid.toLowerCase().endsWith(UID_SUFFIX)) {
      plan.skipped++;
      continue;
    }
    if (ev.status === 'CANCELLED') continue; // not marked seen → cancelled below
    if (seen.has(ev.uid)) continue;
    if (ev.end <= today) {
      seen.add(ev.uid); // over: keep whatever we have, change nothing
      continue;
    }

    const info = describeChannelEvent(channel, ev);
    const known = byUid.get(ev.uid);

    if (!known && info.blockOnly) {
      const covered = nightsCovered(ev.start, ev.end, otherLiveOnUnit, now);
      if (covered) {
        plan.skipped++;
        continue;
      }
    }

    seen.add(ev.uid);
    if (!known) {
      plan.inserts.push({
        external_uid: ev.uid,
        check_in: ev.start,
        check_out: ev.end,
        guest_name: info.label,
        external_ref: info.externalRef,
        notes: info.notes,
      });
    } else if (
      known.check_in !== ev.start ||
      known.check_out !== ev.end ||
      known.status !== 'confirmed'
    ) {
      plan.updates.push({ id: known.id, check_in: ev.start, check_out: ev.end });
    }
  }

  for (const r of existing) {
    if (!r.external_uid || seen.has(r.external_uid)) continue;
    if (r.status !== 'cancelled' && r.check_out > today) plan.cancels.push(r.id);
  }

  return plan;
}

/** Is every night of [start, end) inside some live reservation of the list? */
function nightsCovered(start: string, end: string, others: OtherRes[], now: Date): boolean {
  const live = others.filter((r) => isLive(r, now));
  for (let night = start; night < end; night = addDays(night, 1)) {
    if (!live.some((r) => r.check_in <= night && night < r.check_out)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportEvent = { uid: string; start: string; end: string; summary: string };

const compact = (date: string) => date.replaceAll('-', '');

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

/** Fold to 75 octets per line as RFC 5545 asks (ASCII-safe: we only emit ASCII-ish text). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(' ' + line.slice(i, i + 74));
  return parts.join('\r\n');
}

/**
 * A calendar of busy dates for one unit, for Airbnb / Booking.com to import.
 * Carries no guest data: the URL is a bearer credential that ends up stored
 * in third-party systems.
 */
export function generateIcal(calendarName: string, events: ExportEvent[], stamp: Date = new Date()): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TableFront//Stays//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}${UID_SUFFIX}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${compact(ev.start)}`,
      `DTEND;VALUE=DATE:${compact(ev.end)}`,
      `SUMMARY:${escapeText(ev.summary)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
