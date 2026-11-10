import type { TKey } from '../i18n';
import type { StayReservation, StaySource } from '../types';

type T = (key: TKey, vars?: Record<string, string>) => string;

/** True for reservations that arrived through a channel calendar. */
export function isChannelSource(source: StaySource): boolean {
  return source !== 'widget' && source !== 'manual';
}

export function sourceLabel(source: StaySource, t: T): string {
  if (source === 'widget') return t('source.widget');
  if (source === 'manual') return t('source.manual');
  return t(`source.${source}` as TKey);
}

/**
 * Who to show for a reservation. Channel calendars carry no guest name, so an
 * imported reservation starts out with the channel's own wording ("Reserved",
 * "CLOSED - Not available"); show something readable until the owner types
 * the real name in.
 */
export function guestLabel(res: Pick<StayReservation, 'guest_name' | 'source'>, t: T): string {
  if (!isChannelSource(res.source)) return res.guest_name;
  const channel = sourceLabel(res.source, t);
  const name = res.guest_name.trim();
  if (res.source === 'airbnb' && /not available/i.test(name)) {
    return t('stay.channelBlocked', { channel });
  }
  if (/^(reserved|closed\b.*|.*not available.*|blocked|unavailable)$/i.test(name) || !name) {
    return t('stay.channelReservation', { channel });
  }
  return name;
}

/** Bar colours on the calendar, by where the reservation came from. */
export const SOURCE_COLORS: Record<StaySource, { bg: string; fg: string }> = {
  widget: { bg: '#8c4225', fg: '#ffffff' },
  manual: { bg: '#1a1208', fg: '#f5efe0' },
  airbnb: { bg: '#d9475a', fg: '#ffffff' },
  booking: { bg: '#1f4e9c', fg: '#ffffff' },
  vrbo: { bg: '#2f6f8f', fg: '#ffffff' },
  other: { bg: '#6b5f4b', fg: '#ffffff' },
};
