import { createServerSupabase } from '@/lib/supabase/server';
import { saveSettings } from '@/app/actions';
import type { CapacityRule, Restaurant } from '@/lib/types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const input =
  'rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-900 focus:outline-none';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  if (!restaurant) return null;

  const { data: rules } = await supabase
    .from('capacity_rules')
    .select('*')
    .is('specific_date', null)
    .is('time_slot', null)
    .returns<CapacityRule[]>();
  const capByDay = new Map((rules ?? []).map((r) => [r.day_of_week, r.max_covers]));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.tablesfront.com';
  const snippet = `<div data-tablefront-widget data-restaurant="${restaurant.id}"></div>\n<script src="${appUrl}/widget.js" async></script>`;

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Operating hours, time slots and online booking capacity for {restaurant.name}.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {saved && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Settings saved.
        </p>
      )}

      <form action={saveSettings} className="space-y-6 rounded-xl border border-neutral-200 bg-white p-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="slotInterval" className="block text-sm font-medium text-neutral-700">
              Slot interval (minutes)
            </label>
            <input
              id="slotInterval"
              name="slotInterval"
              type="number"
              min={15}
              max={120}
              step={5}
              defaultValue={restaurant.slot_interval_minutes}
              className={`${input} mt-1 w-full`}
            />
          </div>
          <div>
            <label htmlFor="defaultMaxCovers" className="block text-sm font-medium text-neutral-700">
              Default max covers per slot (online)
            </label>
            <input
              id="defaultMaxCovers"
              name="defaultMaxCovers"
              type="number"
              min={0}
              defaultValue={restaurant.default_max_covers}
              className={`${input} mt-1 w-full`}
            />
          </div>
        </div>

        <div>
          <h2 className="text-sm font-medium text-neutral-900">Hours &amp; per-day capacity</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Leave “cap override” empty to use the default. The cap only limits online
            bookings — manual bookings you add are never blocked by it.
          </p>
          <div className="mt-3 space-y-2">
            {DAYS.map((day, d) => {
              const h = restaurant.operating_hours[String(d)] ?? {
                open: '18:00',
                close: '22:00',
                closed: true,
              };
              return (
                <div key={d} className="grid grid-cols-[7rem_auto_1fr_1fr_1fr] items-center gap-3">
                  <span className="text-sm text-neutral-700">{day}</span>
                  <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                    <input type="checkbox" name={`closed_${d}`} defaultChecked={h.closed} />
                    Closed
                  </label>
                  <input type="time" name={`open_${d}`} defaultValue={h.open} className={input} />
                  <input type="time" name={`close_${d}`} defaultValue={h.close} className={input} />
                  <input
                    type="number"
                    name={`cap_${d}`}
                    min={0}
                    placeholder="cap override"
                    defaultValue={capByDay.get(d) ?? ''}
                    className={input}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <button className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700">
          Save settings
        </button>
      </form>

      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="text-sm font-medium text-neutral-900">Embed the booking widget</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Paste this snippet into your website where the booking form should appear. Theme it
          with CSS custom properties (<code>--tf-accent</code>, <code>--tf-font</code>,{' '}
          <code>--tf-radius</code>) on any parent element.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-neutral-900 p-4 text-xs text-neutral-100">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
