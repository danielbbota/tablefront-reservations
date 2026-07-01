import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase/server';
import { setBookingStatus } from '@/app/actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import type { Booking, Restaurant } from '@/lib/types';

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showPast = view === 'past';

  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  const today = restaurant ? nowInTimezone(restaurant.timezone).date : new Date().toISOString().slice(0, 10);

  const query = supabase.from('bookings').select('*');
  const { data: bookings } = await (showPast
    ? query.lt('date', today).order('date', { ascending: false }).order('time_slot', { ascending: false }).limit(200)
    : query.gte('date', today).order('date', { ascending: true }).order('time_slot', { ascending: true })
  ).returns<Booking[]>();

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-neutral-900">
          {showPast ? 'Past bookings' : 'Upcoming bookings'}
        </h1>
        <div className="flex gap-2 text-sm">
          <Link
            href="/"
            className={`rounded-md px-3 py-1.5 ${!showPast ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900'}`}
          >
            Upcoming
          </Link>
          <Link
            href="/?view=past"
            className={`rounded-md px-3 py-1.5 ${showPast ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900'}`}
          >
            Past
          </Link>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Guest</th>
              <th className="px-4 py-3">Party</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(bookings ?? []).map((b) => (
              <tr key={b.id} className={b.status === 'cancelled' ? 'text-neutral-400' : ''}>
                <td className="whitespace-nowrap px-4 py-3">{b.date}</td>
                <td className="px-4 py-3">{normalizeSlot(b.time_slot)}</td>
                <td className="px-4 py-3 font-medium">{b.guest_name}</td>
                <td className="px-4 py-3">{b.party_size}</td>
                <td className="px-4 py-3">
                  <div>{b.guest_phone}</div>
                  <div className="text-xs text-neutral-400">{b.guest_email}</div>
                </td>
                <td className="max-w-48 px-4 py-3 text-xs">{b.notes}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      b.status === 'confirmed'
                        ? 'bg-green-50 text-green-700'
                        : 'bg-neutral-100 text-neutral-500'
                    }`}
                  >
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">{b.source}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {b.status === 'confirmed' ? (
                    <form action={setBookingStatus.bind(null, b.id, 'cancelled')}>
                      <button className="text-xs font-medium text-red-600 hover:text-red-800">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <form action={setBookingStatus.bind(null, b.id, 'confirmed')}>
                      <button className="text-xs font-medium text-green-700 hover:text-green-900">
                        Re-confirm
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {(bookings ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-neutral-400">
                  No {showPast ? 'past' : 'upcoming'} bookings.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-neutral-400">
        Cancelling a booking emails the guest automatically.
      </p>
    </div>
  );
}
