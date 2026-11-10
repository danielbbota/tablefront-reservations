'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Date navigation for the appointments calendar: previous / next day, a
 * native date picker and "Today". Refreshes the page every 60s so online
 * bookings show up during the day without a reload.
 */
export default function AgendaControls({
  date,
  labels,
}: {
  date: string;
  labels: { today: string; previous: string; next: string; pick: string };
}) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(id);
  }, [router]);

  function shift(days: number) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    router.push(`/agenda?date=${d.toISOString().slice(0, 10)}`);
  }

  const btn =
    'flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-linen bg-white px-3 py-2 text-sm font-medium text-espresso transition hover:border-caramel active:scale-95';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => shift(-1)} aria-label={labels.previous} className={btn}>
        <ChevronLeft size={16} aria-hidden />
      </button>
      <input
        type="date"
        value={date}
        aria-label={labels.pick}
        onChange={(e) => e.target.value && router.push(`/agenda?date=${e.target.value}`)}
        className="min-h-11 rounded-lg border border-linen bg-white px-3 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
      />
      <button type="button" onClick={() => shift(1)} aria-label={labels.next} className={btn}>
        <ChevronRight size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => router.push('/agenda')}
        className="min-h-11 rounded-lg bg-caramel px-4 py-2 text-sm font-semibold text-espresso transition hover:bg-terracotta hover:text-cream active:scale-95"
      >
        {labels.today}
      </button>
    </div>
  );
}
