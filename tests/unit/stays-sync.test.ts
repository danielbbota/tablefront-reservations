// Fetching channel calendars safely: which addresses the server will fetch,
// how redirects are followed, and what counts as "stale".
import { describe, expect, it, vi } from 'vitest';
import { FeedUrlError, anyFeedStale, assertSafeFeedUrl, fetchFeed } from '@/lib/stays/sync';

describe('assertSafeFeedUrl', () => {
  it.each([
    'https://www.airbnb.com/calendar/ical/12345.ics?s=abcdef',
    'https://ical.booking.com/v1/export?t=0f0f0f0f',
    'https://www.vrbo.com/icalendar/abc.ics',
  ])('accepts %s', (url) => {
    expect(assertSafeFeedUrl(url).protocol).toBe('https:');
  });

  it.each([
    ['plain http', 'http://www.airbnb.com/calendar/ical/1.ics'],
    ['not a URL', 'airbnb calendar'],
    ['webcal scheme', 'webcal://www.airbnb.com/calendar/ical/1.ics'],
    ['localhost', 'https://localhost/a.ics'],
    ['loopback IP', 'https://127.0.0.1/a.ics'],
    ['private IP', 'https://10.0.0.5/a.ics'],
    ['cloud metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 literal', 'https://[::1]/a.ics'],
    ['single-label host', 'https://intranet/a.ics'],
    ['internal suffix', 'https://db.internal/a.ics'],
    ['embedded credentials', 'https://user:pass@www.airbnb.com/a.ics'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeFeedUrl(url)).toThrow(FeedUrlError);
  });
});

describe('fetchFeed', () => {
  const calendar = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
  const response = (status: number, body = '', headers: Record<string, string> = {}) =>
    new Response(status >= 300 && status < 400 ? null : body, { status, headers });

  it('returns the calendar text', async () => {
    const fetchImpl = vi.fn(async () => response(200, calendar));
    await expect(fetchFeed('https://www.airbnb.com/calendar/ical/1.ics', fetchImpl as never)).resolves.toBe(calendar);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another public host', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, '', { location: 'https://www.airbnb.pt/calendar/ical/1.ics' }))
      .mockResolvedValueOnce(response(200, calendar));
    await expect(fetchFeed('https://www.airbnb.com/calendar/ical/1.ics', fetchImpl as never)).resolves.toBe(calendar);
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://www.airbnb.pt/calendar/ical/1.ics');
  });

  it('refuses a redirect that points inside the network', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, '', { location: 'https://169.254.169.254/latest/meta-data' }));
    await expect(fetchFeed('https://www.airbnb.com/calendar/ical/1.ics', fetchImpl as never)).rejects.toThrow(FeedUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up on a redirect loop and on error statuses', async () => {
    const loop = vi.fn(async () => response(301, '', { location: 'https://www.airbnb.com/again.ics' }));
    await expect(fetchFeed('https://www.airbnb.com/a.ics', loop as never)).rejects.toThrow(/Too many redirects/);

    const gone = vi.fn(async () => response(404, 'nope'));
    await expect(fetchFeed('https://www.airbnb.com/a.ics', gone as never)).rejects.toThrow(/HTTP 404/);
  });
});

describe('anyFeedStale', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  it('is true for a feed that was never synced or is older than the limit', () => {
    expect(anyFeedStale([{ last_synced_at: null }], 15, now)).toBe(true);
    expect(anyFeedStale([{ last_synced_at: '2030-01-01T11:40:00Z' }], 15, now)).toBe(true);
  });
  it('is false when every feed is fresh, or there are none', () => {
    expect(anyFeedStale([{ last_synced_at: '2030-01-01T11:50:00Z' }], 15, now)).toBe(false);
    expect(anyFeedStale([], 15, now)).toBe(false);
  });
});
