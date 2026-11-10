import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, CalendarClock, CheckCircle2, Link2, Trash2 } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import CopyButton from '@/components/copy-button';
import { asLang, getT, LOCALE, type TKey } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { sourceLabel } from '@/lib/stays/display';
import {
  addStayFeed,
  addStayRate,
  deleteStayFeed,
  deleteStayRate,
  deleteStayUnit,
} from '@/app/stays-actions';
import {
  STAY_CHANNELS,
  currencyOf,
  type StayIcalFeed,
  type StayRate,
  type StayUnit,
} from '@/lib/types';
import UnitForm from '../unit-form';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';
const card = 'rounded-2xl border border-linen bg-white p-6 shadow-card';

export default async function StayUnitPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; synced?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, business } = await requireBusiness('stays');
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);

  const [{ data: unit }, { data: rates }, { data: feeds }] = await Promise.all([
    supabase.from('stay_units').select('*').eq('id', id).maybeSingle<StayUnit>(),
    supabase.from('stay_rates').select('*').eq('unit_id', id).order('start_date').returns<StayRate[]>(),
    supabase.from('stay_ical_feeds').select('*').eq('unit_id', id).order('created_at').returns<StayIcalFeed[]>(),
  ]);
  if (!unit) notFound();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.tablesfront.com';
  const exportBase = `${appUrl}/api/public/ical/${unit.ical_token}.ics`;
  const exports = [
    { channel: 'airbnb' as const, url: `${exportBase}?for=airbnb` },
    { channel: 'booking' as const, url: `${exportBase}?for=booking` },
    { channel: 'vrbo' as const, url: `${exportBase}?for=vrbo` },
  ];
  const when = (iso: string) =>
    new Date(iso).toLocaleString(LOCALE[lang], {
      timeZone: business.timezone,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="tf-rise max-w-2xl space-y-10">
      <div>
        <Link href="/stays/units" className="text-xs font-semibold text-caramel hover:text-terracotta">
          ← {t('nav.stays.units')}
        </Link>
        <h1 className="mt-2 font-serif text-2xl font-semibold text-espresso">{unit.name}</h1>

        {sp.error && (
          <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
            {sp.error}
          </p>
        )}
        {sp.synced !== undefined ? (
          <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">
            {t('stay.channels.connected', { n: sp.synced })}
          </p>
        ) : (
          sp.saved && (
            <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('common.saved')}</p>
          )
        )}

        <div className="mt-6">
          <UnitForm unit={unit} currency={currency} t={t} />
        </div>
      </div>

      <section id="rates" className="scroll-mt-24">
        <h2 className="flex items-center gap-2 font-serif text-xl font-semibold text-espresso">
          <CalendarClock size={17} aria-hidden className="text-caramel" />
          {t('stay.rates.title')}
        </h2>
        <p className="mt-1.5 text-sm text-espresso/60">
          {t('stay.rates.subtitle', { price: formatMoney(unit.base_price_cents, currency, lang) })}
        </p>

        <div className={`${card} mt-4`}>
          {(rates ?? []).length > 0 && (
            <ul className="mb-5 divide-y divide-linen/60">
              {(rates ?? []).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-espresso">
                    {r.start_date} → {r.end_date}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium text-espresso">
                      {t('stay.units.perNight', { price: formatMoney(r.price_cents, currency, lang) })}
                    </span>
                    {r.min_nights && (
                      <span className="text-xs text-espresso/55">
                        {t('stay.rates.min', { n: String(r.min_nights) })}
                      </span>
                    )}
                    <form action={deleteStayRate.bind(null, r.id, unit.id)}>
                      <button
                        aria-label={t('common.remove')}
                        className="flex min-h-9 min-w-9 items-center justify-center rounded-full text-espresso/45 transition hover:bg-wine/10 hover:text-wine"
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form action={addStayRate.bind(null, unit.id)} className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <label htmlFor="rateStart" className={label}>{t('common.from')}</label>
              <input id="rateStart" name="start" type="date" required className={input} />
            </div>
            <div>
              <label htmlFor="rateEnd" className={label}>{t('stay.rates.lastNight')}</label>
              <input id="rateEnd" name="end" type="date" required className={input} />
            </div>
            <div>
              <label htmlFor="ratePrice" className={label}>{t('stay.units.price', { currency })}</label>
              <input id="ratePrice" name="price" type="number" min={0} step="0.01" required className={input} />
            </div>
            <div>
              <label htmlFor="rateMin" className={label}>{t('stay.units.minNights')}</label>
              <input id="rateMin" name="minNights" type="number" min={1} max={90} placeholder="—" className={input} />
            </div>
            <button className="col-span-2 min-h-11 rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta sm:col-span-4 sm:w-fit sm:px-6">
              {t('stay.rates.add')}
            </button>
          </form>
        </div>
      </section>

      <section id="channels" className="scroll-mt-24">
        <h2 className="flex items-center gap-2 font-serif text-xl font-semibold text-espresso">
          <Link2 size={17} aria-hidden className="text-caramel" />
          {t('stay.channels.title')}
        </h2>
        <p className="mt-1.5 text-sm text-espresso/60">{t('stay.channels.subtitle')}</p>

        <div className={`${card} mt-4 space-y-6`}>
          <div>
            <h3 className="text-sm font-semibold text-espresso">{t('stay.channels.importTitle')}</h3>
            <p className="mt-1 text-xs text-espresso/55">{t('stay.channels.importHint')}</p>

            {(feeds ?? []).length > 0 && (
              <ul className="mt-3 divide-y divide-linen/60">
                {(feeds ?? []).map((f) => (
                  <li key={f.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 font-medium text-espresso">
                        {f.last_status === 'error' ? (
                          <AlertTriangle size={14} aria-hidden className="text-wine" />
                        ) : (
                          <CheckCircle2 size={14} aria-hidden className="text-leaf" />
                        )}
                        {sourceLabel(f.channel, t)}
                      </p>
                      <p className="truncate text-xs text-espresso/45">{f.url}</p>
                      <p className={`text-xs ${f.last_status === 'error' ? 'text-wine' : 'text-espresso/55'}`}>
                        {f.last_status === 'error'
                          ? t('stay.sync.feedFailed', { message: f.last_error ?? '' })
                          : f.last_synced_at
                            ? t('stay.sync.last', { when: when(f.last_synced_at) })
                            : t('stay.sync.never')}
                      </p>
                    </div>
                    <form action={deleteStayFeed.bind(null, f.id, unit.id)}>
                      <button
                        aria-label={t('common.remove')}
                        className="flex min-h-9 min-w-9 items-center justify-center rounded-full text-espresso/45 transition hover:bg-wine/10 hover:text-wine"
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <form action={addStayFeed.bind(null, unit.id)} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[9rem_1fr_auto]">
              <div>
                <label htmlFor="channel" className="sr-only">{t('stay.channels.channel')}</label>
                <select id="channel" name="channel" defaultValue="airbnb" className={input}>
                  {STAY_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {t(`source.${c}` as TKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="feedUrl" className="sr-only">{t('stay.channels.url')}</label>
                <input
                  id="feedUrl"
                  name="url"
                  type="url"
                  required
                  placeholder="https://www.airbnb.com/calendar/ical/…"
                  className={input}
                />
              </div>
              <button className="mt-1 min-h-11 rounded-lg bg-espresso px-5 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta">
                {t('stay.channels.connect')}
              </button>
            </form>
          </div>

          <div className="border-t border-linen/60 pt-5">
            <h3 className="text-sm font-semibold text-espresso">{t('stay.channels.exportTitle')}</h3>
            <p className="mt-1 text-xs text-espresso/55">{t('stay.channels.exportHint')}</p>
            <ul className="mt-3 space-y-2">
              {exports.map((e) => (
                <li key={e.channel} className="flex items-center gap-3 rounded-lg bg-sand/50 px-3 py-2">
                  <span className="w-24 flex-none text-xs font-semibold text-espresso">
                    {sourceLabel(e.channel, t)}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-[11px] text-espresso/60">{e.url}</code>
                  <CopyButton text={e.url} label={t('settings.copy')} copiedLabel={t('settings.copied')} />
                </li>
              ))}
            </ul>
          </div>

          <p className="rounded-lg bg-caramel/15 px-4 py-3 text-xs leading-relaxed text-espresso/80">
            {t('stay.channels.limits')}
          </p>
        </div>
      </section>

      <section>
        <form action={deleteStayUnit.bind(null, unit.id)}>
          <button className="min-h-11 rounded-lg border border-wine/30 px-5 py-2.5 text-sm font-semibold text-wine transition hover:bg-wine/10">
            {t('stay.units.delete')}
          </button>
          <p className="mt-2 text-xs text-espresso/50">{t('stay.units.deleteHint')}</p>
        </form>
      </section>
    </div>
  );
}
