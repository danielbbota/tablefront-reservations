import { Ban, Trash2 } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import { addDays, isIsoDate } from '@/lib/stays/dates';
import { createStayBlock, createStayReservation, deleteStayBlock } from '@/app/stays-actions';
import { currencyOf, type StayBlock, type StayUnit } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

export default async function NewStayReservationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; unit?: string; checkIn?: string; blocked?: string }>;
}) {
  const sp = await searchParams;
  const { supabase, business } = await requireBusiness('stays');
  const t = getT(asLang(business.language));
  const today = nowInTimezone(business.timezone).date;

  const [{ data: units }, { data: blocks }] = await Promise.all([
    supabase
      .from('stay_units')
      .select('*')
      .eq('active', true)
      .order('sort')
      .order('name')
      .returns<StayUnit[]>(),
    supabase
      .from('stay_blocks')
      .select('*')
      .gte('end_date', today)
      .order('start_date')
      .returns<StayBlock[]>(),
  ]);
  const unitName = new Map((units ?? []).map((u) => [u.id, u.name]));
  const checkIn = isIsoDate(sp.checkIn) ? sp.checkIn : '';
  const checkOut = checkIn ? addDays(checkIn, 1) : '';
  const unitOptions = (units ?? []).map((u) => (
    <option key={u.id} value={u.id}>
      {u.name} · {u.max_guests}
    </option>
  ));

  return (
    <div className="tf-rise grid max-w-4xl grid-cols-1 gap-8 lg:grid-cols-[3fr_2fr]">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-espresso">{t('stay.new.title')}</h1>
        <p className="mt-1.5 text-sm text-espresso/60">{t('stay.new.subtitle')}</p>

        {sp.error && (
          <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
            {sp.error}
          </p>
        )}

        <form
          action={createStayReservation}
          className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
        >
          <div>
            <label htmlFor="unitId" className={label}>{t('stay.unit')}</label>
            <select id="unitId" name="unitId" required defaultValue={sp.unit ?? ''} className={input}>
              <option value="" disabled>
                —
              </option>
              {unitOptions}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="checkIn" className={label}>{t('stay.checkIn')}</label>
              <input id="checkIn" name="checkIn" type="date" required defaultValue={checkIn} className={input} />
            </div>
            <div>
              <label htmlFor="checkOut" className={label}>{t('stay.checkOut')}</label>
              <input id="checkOut" name="checkOut" type="date" required defaultValue={checkOut} className={input} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="guests" className={label}>{t('stay.guests')}</label>
              <input id="guests" name="guests" type="number" min={1} max={30} defaultValue={2} required className={input} />
            </div>
            <div>
              <label htmlFor="total" className={label}>
                {t('stay.form.total', { currency: currencyOf(business) })}
              </label>
              <input id="total" name="total" type="number" min={0} step="0.01" placeholder={t('stay.form.totalAuto')} className={input} />
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
            {t('stay.new.create')}
          </button>
        </form>
      </div>

      <div>
        <h2 className="flex items-center gap-2 font-serif text-xl font-semibold text-espresso">
          <Ban size={17} aria-hidden className="text-caramel" />
          {t('stay.block.title')}
        </h2>
        <p className="mt-1.5 text-sm text-espresso/60">{t('stay.block.subtitle')}</p>

        {sp.blocked && (
          <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('common.saved')}</p>
        )}

        <form
          action={createStayBlock}
          className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
        >
          <div>
            <label htmlFor="blockUnit" className={label}>{t('stay.unit')}</label>
            <select id="blockUnit" name="unitId" required defaultValue={sp.unit ?? ''} className={input}>
              <option value="" disabled>
                —
              </option>
              {unitOptions}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="blockStart" className={label}>{t('common.from')}</label>
              <input id="blockStart" name="start" type="date" required className={input} />
            </div>
            <div>
              <label htmlFor="blockEnd" className={label}>{t('stay.block.until')}</label>
              <input id="blockEnd" name="end" type="date" required className={input} />
            </div>
          </div>
          <div>
            <label htmlFor="reason" className={label}>{t('stay.block.reason')}</label>
            <input id="reason" name="reason" maxLength={80} className={input} />
          </div>
          <button className="min-h-11 w-full rounded-lg border border-espresso/20 bg-sand px-4 py-2.5 text-sm font-semibold text-espresso transition hover:bg-linen">
            {t('stay.block.create')}
          </button>
        </form>

        {(blocks ?? []).length > 0 && (
          <ul className="mt-4 divide-y divide-linen/60 rounded-2xl border border-linen bg-white px-4 shadow-card">
            {(blocks ?? []).map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="block truncate font-medium text-espresso">
                    {unitName.get(b.unit_id) ?? '—'}
                  </span>
                  <span className="block text-xs text-espresso/55">
                    {b.start_date} → {b.end_date}
                    {b.reason ? ` · ${b.reason}` : ''}
                  </span>
                </div>
                <form action={deleteStayBlock.bind(null, b.id)}>
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
      </div>
    </div>
  );
}
