'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Calendar navigation for the day view: previous/next arrows, a native
 * date picker, and a quick "Today" button. Also silently refreshes the
 * page every 60s so new bookings appear during service without a reload.
 */
export default function DayControls({
  date,
  todayLabel,
}: {
  date: string;
  todayLabel: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(id);
  }, [router]);

  function shift(days: number) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    router.push(`/day?date=${d.toISOString().slice(0, 10)}`);
  }

  const btn =
    'rounded-lg border border-linen bg-white px-3 py-2 text-sm font-medium text-espresso transition hover:border-caramel active:scale-95';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => shift(-1)} aria-label="Previous day" className={btn}>
        ←
      </button>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && router.push(`/day?date=${e.target.value}`)}
        className="rounded-lg border border-linen bg-white px-3 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
      />
      <button type="button" onClick={() => shift(1)} aria-label="Next day" className={btn}>
        →
      </button>
      <button
        type="button"
        onClick={() => router.push('/day')}
        className="rounded-lg bg-caramel px-4 py-2 text-sm font-semibold text-espresso transition hover:bg-terracotta hover:text-cream active:scale-95"
      >
        {todayLabel}
      </button>
    </div>
  );
}
