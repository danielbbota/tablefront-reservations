import Link from 'next/link';
import { BedDouble, ChevronRight, Users } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { sourceLabel } from '@/lib/stays/display';
import { currencyOf, type StayIcalFeed, type StayUnit } from '@/lib/types';
import UnitForm from './unit-form';

export default async function StayUnitsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { supabase, business } = await requireBusiness('stays');
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);

  const [{ data: units }, { data: feeds }] = await Promise.all([
    supabase.from('stay_units').select('*').order('sort').order('name').returns<StayUnit[]>(),
    supabase.from('stay_ical_feeds').select('*').returns<StayIcalFeed[]>(),
  ]);

  return (
    <div className="tf-rise max-w-3xl">
      <h1 className="font-serif text-2xl font-semibold text-espresso">{t('stay.units.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">{t('stay.units.subtitle')}</p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      <ul className="mt-6 space-y-3">
        {(units ?? []).map((u) => {
          const unitFeeds = (feeds ?? []).filter((f) => f.unit_id === u.id);
          const broken = unitFeeds.some((f) => f.last_status === 'error');
          return (
            <li key={u.id}>
              <Link
                href={`/stays/units/${u.id}`}
                className="tf-lift flex items-center gap-4 rounded-2xl border border-linen bg-white p-5 shadow-card"
              >
                <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-sand">
                  <BedDouble size={20} aria-hidden className="text-caramel" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`truncate font-medium ${u.active ? 'text-espresso' : 'text-espresso/45'}`}>
                    {u.name}
                    {!u.active && (
                      <span className="ml-2 rounded-full bg-espresso/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-espresso/50">
                        {t('common.inactive')}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-espresso/55">
                    <span className="flex items-center gap-1">
                      <Users size={12} aria-hidden />
                      {u.max_guests}
                    </span>
                    <span>
                      {t('stay.units.perNight', {
                        price: formatMoney(u.base_price_cents, currency, lang),
                      })}
                    </span>
                    {unitFeeds.length > 0 ? (
                      <span className={broken ? 'font-semibold text-wine' : 'text-leaf'}>
                        {unitFeeds.map((f) => sourceLabel(f.channel, t)).join(' · ')}
                        {broken ? ` — ${t('stay.channels.failing')}` : ''}
                      </span>
                    ) : (
                      <span>{t('stay.channels.none')}</span>
                    )}
                  </p>
                </div>
                <ChevronRight size={18} aria-hidden className="flex-none text-espresso/30" />
              </Link>
            </li>
          );
        })}
        {(units ?? []).length === 0 && (
          <li className="rounded-2xl border border-dashed border-linen bg-white/60 p-8 text-center text-sm text-espresso/50">
            {t('stay.units.empty')}
          </li>
        )}
      </ul>

      <h2 className="mt-10 font-serif text-xl font-semibold text-espresso">{t('stay.units.add')}</h2>
      <div className="mt-4">
        <UnitForm currency={currency} t={t} />
      </div>
    </div>
  );
}
