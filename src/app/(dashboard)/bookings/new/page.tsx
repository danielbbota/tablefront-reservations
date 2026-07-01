import { createServerSupabase } from '@/lib/supabase/server';
import { createManualBooking } from '@/app/actions';
import type { Restaurant } from '@/lib/types';

const input =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none';

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();

  return (
    <div className="max-w-lg">
      <h1 className="text-lg font-semibold text-neutral-900">Add booking</h1>
      <p className="mt-1 text-sm text-neutral-500">
        For walk-ins and phone bookings. Manual bookings are not limited by the online
        capacity cap.
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <form action={createManualBooking} className="mt-6 space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="date" className="block text-sm font-medium text-neutral-700">Date</label>
            <input id="date" name="date" type="date" required className={input} />
          </div>
          <div>
            <label htmlFor="time" className="block text-sm font-medium text-neutral-700">Time</label>
            <input
              id="time"
              name="time"
              type="time"
              required
              step={(restaurant?.slot_interval_minutes ?? 30) * 60}
              className={input}
            />
          </div>
        </div>
        <div>
          <label htmlFor="partySize" className="block text-sm font-medium text-neutral-700">Party size</label>
          <input id="partySize" name="partySize" type="number" min={1} max={50} required className={input} />
        </div>
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-neutral-700">Guest name</label>
          <input id="name" name="name" required className={input} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-neutral-700">Phone</label>
            <input id="phone" name="phone" className={input} />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-neutral-700">Email</label>
            <input id="email" name="email" type="email" className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-neutral-700">Notes</label>
          <textarea id="notes" name="notes" rows={2} className={input} />
        </div>
        <button className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700">
          Create booking
        </button>
      </form>
    </div>
  );
}
