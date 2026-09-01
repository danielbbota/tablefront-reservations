import { createServerSupabase } from '@/lib/supabase/server';
import { createManualBooking } from '@/app/actions';
import { asLang, getT } from '@/lib/i18n';
import type { FloorTable, FloorZone, Restaurant } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createServerSupabase();
  const [{ data: restaurant }, { data: zones }, { data: floorTables }] = await Promise.all([
    supabase.from('restaurants').select('*').single<Restaurant>(),
    supabase.from('floor_zones').select('*').order('sort').returns<FloorZone[]>(),
    supabase.from('floor_tables').select('*').returns<FloorTable[]>(),
  ]);
  const t = getT(asLang(restaurant?.language));
  const hasFloor = (floorTables ?? []).length > 0;

  return (
    <div className="tf-rise max-w-lg">
      <h1 className="font-serif text-2xl font-semibold text-espresso">{t('add.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">{t('add.subtitle')}</p>

      {error && (
        <p className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">{error}</p>
      )}

      <form
        action={createManualBooking}
        className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
      >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="date" className={label}>{t('form.date')}</label>
            <input id="date" name="date" type="date" required className={input} />
          </div>
          <div>
            <label htmlFor="time" className={label}>{t('form.time')}</label>
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
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="partySize" className={label}>{t('form.party')}</label>
            <input id="partySize" name="partySize" type="number" min={1} max={50} required className={input} />
          </div>
          <div>
            <label htmlFor="table" className={label}>{t('form.table')}</label>
            {hasFloor ? (
              <select id="table" name="tableId" defaultValue="" className={input}>
                <option value="">—</option>
                {(zones ?? []).map((z) => (
                  <optgroup key={z.id} label={z.name}>
                    {(floorTables ?? [])
                      .filter((ft) => ft.zone_id === z.id)
                      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                      .map((ft) => (
                        <option key={ft.id} value={ft.id}>
                          {ft.name} · {ft.seats}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input id="table" name="table" className={input} />
            )}
          </div>
        </div>
        <div>
          <label htmlFor="name" className={label}>{t('form.name')}</label>
          <input id="name" name="name" required className={input} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="phone" className={label}>{t('form.phone')}</label>
            <input id="phone" name="phone" className={input} />
          </div>
          <div>
            <label htmlFor="email" className={label}>{t('form.email')}</label>
            <input id="email" name="email" type="email" className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="notes" className={label}>{t('form.notes')}</label>
          <textarea id="notes" name="notes" rows={2} className={input} />
        </div>
        <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
          {t('form.create')}
        </button>
      </form>
    </div>
  );
}
