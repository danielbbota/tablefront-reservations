import { Clock, Code2, CreditCard, Globe, MapPin } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import CopyButton from '@/components/copy-button';
import { createAdminClient } from '@/lib/supabase/admin';
import { asLang, getT, LANGS, type TKey } from '@/lib/i18n';
import { refreshPaymentAccount } from '@/lib/payments/account';
import { paymentsConfigured } from '@/lib/payments/stripe';
import { connectStripe, savePaymentSettings } from '@/app/payment-actions';
import { saveAppointmentsSettings } from '@/app/settings-actions';
import { saveStaysSettings } from '@/app/stays-actions';
import { businessTypeOf, currencyOf, type PaymentAccount, type Restaurant } from '@/lib/types';

const input =
  'rounded-lg border border-linen bg-white px-2.5 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';
const card = 'rounded-2xl border border-linen bg-white p-6 shadow-card';
const primary =
  'min-h-11 rounded-lg bg-espresso px-6 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]';

/** Two-decimal currencies only: amounts are stored in cents. */
const CURRENCIES = ['EUR', 'GBP', 'CHF', 'USD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'BRL'];

/** Settings for stays and appointments businesses (restaurants keep their own page). */
export default async function VerticalSettings({
  supabase,
  business,
  params,
}: {
  supabase: SupabaseClient;
  business: Restaurant;
  params: { error?: string; saved?: string; paysaved?: string; stripe?: string };
}) {
  const type = businessTypeOf(business);
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);

  const timezones = Intl.supportedValuesOf('timeZone');
  if (!timezones.includes(business.timezone)) timezones.unshift(business.timezone);
  const currencies = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];

  // Back from Stripe's onboarding: ask Stripe where the account stands now.
  let account: PaymentAccount | null;
  if (params.stripe) {
    account = await refreshPaymentAccount(createAdminClient(), business.id);
  } else {
    const { data } = await supabase.from('payment_accounts').select('*').maybeSingle<PaymentAccount>();
    account = data;
  }
  const stripeOn = paymentsConfigured();
  const mode = business.payment_mode ?? 'none';

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.tablesfront.com';
  const snippet = `<div data-tablefront-widget data-restaurant="${business.id}"></div>\n<script src="${appUrl}/widget.js" async></script>`;

  return (
    <div className="tf-rise max-w-2xl space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-espresso">{t('settings.title')}</h1>
        <p className="mt-1.5 text-sm text-espresso/60">
          {t(type === 'stays' ? 'stay.settings.subtitle' : 'vset.appts.subtitle')} {business.name}.
        </p>
      </div>

      {params.error && (
        <p role="alert" className="rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {params.error}
        </p>
      )}
      {params.saved && (
        <p className="rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('settings.saved')}</p>
      )}

      <form
        action={type === 'stays' ? saveStaysSettings : saveAppointmentsSettings}
        className={`${card} space-y-6`}
      >
        <div>
          <label htmlFor="language" className={`${label} flex items-center gap-1.5`}>
            <Globe size={14} aria-hidden className="text-caramel" />
            {t('settings.language')}
          </label>
          <select id="language" name="language" defaultValue={lang} className={`${input} mt-1 w-full`}>
            {Object.entries(LANGS).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-espresso/50">{t('settings.languageHint')}</p>
        </div>

        <div>
          <label htmlFor="timezone" className={`${label} flex items-center gap-1.5`}>
            <MapPin size={14} aria-hidden className="text-caramel" />
            {t('settings.timezone')}
          </label>
          <select id="timezone" name="timezone" defaultValue={business.timezone} className={`${input} mt-1 w-full`}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="currency" className={label}>{t('settings.currency')}</label>
            <select id="currency" name="currency" defaultValue={currency} className={`${input} mt-1 w-full`}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {type === 'appointments' && (
            <div>
              <label htmlFor="slotInterval" className={label}>{t('vset.appts.slotInterval')}</label>
              <input
                id="slotInterval"
                name="slotInterval"
                type="number"
                min={15}
                max={120}
                step={5}
                defaultValue={business.slot_interval_minutes}
                className={`${input} mt-1 w-full`}
              />
            </div>
          )}
        </div>

        {type === 'stays' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="checkInTime" className={label}>{t('stay.settings.checkInTime')}</label>
              <input
                id="checkInTime"
                name="checkInTime"
                type="time"
                required
                defaultValue={(business.check_in_time ?? '15:00').slice(0, 5)}
                className={`${input} mt-1 w-full`}
              />
            </div>
            <div>
              <label htmlFor="checkOutTime" className={label}>{t('stay.settings.checkOutTime')}</label>
              <input
                id="checkOutTime"
                name="checkOutTime"
                type="time"
                required
                defaultValue={(business.check_out_time ?? '11:00').slice(0, 5)}
                className={`${input} mt-1 w-full`}
              />
            </div>
          </div>
        )}

        {type === 'appointments' && (
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso">
              <Clock size={14} aria-hidden className="text-caramel" />
              {t('vset.appts.hoursTitle')}
            </h2>
            <p className="mt-1 text-xs text-espresso/50">{t('vset.appts.hoursHint')}</p>
            <div className="mt-4 space-y-2.5">
              {Array.from({ length: 7 }, (_, d) => {
                const h = business.operating_hours[String(d)] ?? {
                  open: '09:00',
                  close: '19:00',
                  closed: true,
                };
                return (
                  <div
                    key={d}
                    className="grid grid-cols-[7.5rem_auto_1fr_1fr] items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-sand/40"
                  >
                    <span className="text-sm text-espresso">{t(`days.${d}` as TKey)}</span>
                    <label className="flex items-center gap-1.5 text-xs text-espresso/60">
                      <input type="checkbox" name={`closed_${d}`} defaultChecked={h.closed} className="tf-switch" />
                      {t('settings.closed')}
                    </label>
                    <input type="time" name={`open_${d}`} defaultValue={h.open} className={input} />
                    <input type="time" name={`close_${d}`} defaultValue={h.close} className={input} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <button className={primary}>{t('settings.save')}</button>
      </form>

      <section id="payments" className={`${card} scroll-mt-24 space-y-5`}>
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso">
            <CreditCard size={14} aria-hidden className="text-caramel" />
            {t('pay.title')}
          </h2>
          <p className="mt-1 text-xs text-espresso/50">{t('pay.hint')}</p>
        </div>

        {params.paysaved && (
          <p className="rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('pay.saved')}</p>
        )}

        <form action={savePaymentSettings} className="space-y-3">
          {(['none', 'deposit', 'full'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2.5 text-sm text-espresso">
              <input
                type="radio"
                name="paymentMode"
                value={m}
                defaultChecked={mode === m}
                className="accent-[#8c4225]"
              />
              {t(`pay.mode.${m}` as TKey)}
            </label>
          ))}
          <div className="max-w-56">
            <label htmlFor="depositPercent" className={label}>{t('pay.depositPercent')}</label>
            <input
              id="depositPercent"
              name="depositPercent"
              type="number"
              min={1}
              max={100}
              defaultValue={business.deposit_percent ?? 30}
              className={`${input} mt-1 w-full`}
            />
          </div>
          <button className={primary}>{t('pay.save')}</button>
        </form>

        <div className="border-t border-linen/60 pt-5">
          <h3 className="text-sm font-semibold text-espresso">{t('pay.stripe.title')}</h3>
          {!stripeOn ? (
            <p className="mt-1 text-sm text-espresso/60">{t('pay.stripe.unavailable')}</p>
          ) : account?.charges_enabled ? (
            <p className="mt-1 text-sm text-leaf">{t('pay.stripe.ready')}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-espresso/70">
                {t(account ? 'pay.stripe.pending' : 'pay.stripe.needed')}
              </p>
              <form action={connectStripe} className="mt-3">
                <button className={primary}>
                  {t(account ? 'pay.stripe.continue' : 'pay.stripe.connect')}
                </button>
              </form>
            </>
          )}
          {stripeOn && <p className="mt-2 text-xs text-espresso/50">{t('pay.stripe.testMode')}</p>}
        </div>
      </section>

      <div className={card}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso">
            <Code2 size={14} aria-hidden className="text-caramel" />
            {t('settings.embedTitle')}
          </h2>
          <CopyButton text={snippet} label={t('settings.copy')} copiedLabel={t('settings.copied')} />
        </div>
        <p className="mt-1 text-xs text-espresso/50">{t('settings.embedHintGeneric')}</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-espresso p-4 text-xs leading-relaxed text-cream">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
