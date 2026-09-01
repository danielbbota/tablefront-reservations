'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Minus, Plus, UserPlus } from 'lucide-react';
import { createWalkIn } from '@/app/floor-actions';

/** Quick walk-in for the plain (no floor plan) day view: party stepper + one tap. */
export default function WalkInButton({
  date,
  time,
  label,
  guestLabel,
}: {
  date: string;
  time: string | null;
  label: string;
  guestLabel: string;
}) {
  const router = useRouter();
  const [party, setParty] = useState(2);
  const [busy, startTransition] = useTransition();

  if (!time) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-linen bg-white p-1.5 shadow-card">
      <button
        aria-label="-"
        onClick={() => setParty((p) => Math.max(1, p - 1))}
        className="flex h-8 w-8 items-center justify-center rounded-full text-espresso/60 transition hover:bg-sand"
      >
        <Minus size={14} aria-hidden />
      </button>
      <span className="tabular w-6 text-center text-sm font-semibold text-espresso">{party}</span>
      <button
        aria-label="+"
        onClick={() => setParty((p) => Math.min(30, p + 1))}
        className="flex h-8 w-8 items-center justify-center rounded-full text-espresso/60 transition hover:bg-sand"
      >
        <Plus size={14} aria-hidden />
      </button>
      <button
        onClick={() =>
          startTransition(async () => {
            await createWalkIn(date, time, party, guestLabel);
            router.refresh();
          })
        }
        disabled={busy}
        className="flex min-h-9 items-center gap-1.5 rounded-full bg-leaf px-4 py-1.5 text-xs font-semibold text-cream transition hover:opacity-90 active:scale-95 disabled:opacity-50"
      >
        <UserPlus size={14} aria-hidden />
        {label}
      </button>
    </div>
  );
}
