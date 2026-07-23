import { Clock, Code2, Globe } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import CopyButton from '@/components/copy-button';
import { saveSettings } from '@/app/actions';
import { asLang, getT, LANGS, type TKey } from '@/lib/i18n';
import type { CapacityRule, Restaurant } from '@/lib/types';

const input =
  'rounded-lg border border-linen bg-white px-2.5 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

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
  const lang = asLang(restaurant.language);
  const t = getT(lang);

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
    <div className="tf-rise max-w-2xl space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-espresso">{t('settings.title')}</h1>
        <p className="mt-1.5 text-sm text-espresso/60">
          {t('settings.subtitle')} {restaurant.name}.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">{error}</p>
      )}
      {saved && (
        <p className="rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('settings.saved')}</p>
      )}

      <form
        action={saveSettings}
        className="space-y-6 rounded-2xl border border-linen bg-white p-6 shadow-card"
      >
        <div>
          <label htmlFor="language" className={`${label} flex items-center gap-1.5`}><Globe size={14} aria-hidden className="text-caramel" />{t('settings.language')}</label>
          <select id="language" name="language" defaultValue={lang} className={`${input} mt-1 w-full`}>
            {Object.entries(LANGS).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-espresso/50">{t('settings.languageHint')}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="slotInterval" className={label}>{t('settings.slotInterval')}</label>
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
            <label htmlFor="defaultMaxCovers" className={label}>{t('settings.defaultCap')}</label>
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
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso"><Clock size={14} aria-hidden className="text-caramel" />{t('settings.hoursTitle')}</h2>
          <p className="mt-1 text-xs text-espresso/50">{t('settings.hoursHint')}</p>
          <div className="mt-4 space-y-2.5">
            {Array.from({ length: 7 }, (_, d) => {
              const h = restaurant.operating_hours[String(d)] ?? {
                open: '18:00',
                close: '22:00',
                closed: true,
              };
              return (
                <div
                  key={d}
                  className="grid grid-cols-[7.5rem_auto_1fr_1fr_1fr] items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-sand/40"
                >
                  <span className="text-sm text-espresso">{t(`days.${d}` as TKey)}</span>
                  <label className="flex items-center gap-1.5 text-xs text-espresso/60">
                    <input type="checkbox" name={`closed_${d}`} defaultChecked={h.closed} className="tf-switch" />
                    {t('settings.closed')}
                  </label>
                  <input type="time" name={`open_${d}`} defaultValue={h.open} className={input} />
                  <input type="time" name={`close_${d}`} defaultValue={h.close} className={input} />
                  <input
                    type="number"
                    name={`cap_${d}`}
                    min={0}
                    placeholder={t('settings.capPlaceholder')}
                    defaultValue={capByDay.get(d) ?? ''}
                    className={input}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <button className="min-h-11 rounded-lg bg-espresso px-6 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
          {t('settings.save')}
        </button>
      </form>

      <div className="rounded-2xl border border-linen bg-white p-6 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso"><Code2 size={14} aria-hidden className="text-caramel" />{t('settings.embedTitle')}</h2>
          <CopyButton text={snippet} label={t('settings.copy')} copiedLabel={t('settings.copied')} />
        </div>
        <p className="mt-1 text-xs text-espresso/50">{t('settings.embedHint')}</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-espresso p-4 text-xs leading-relaxed text-cream">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
