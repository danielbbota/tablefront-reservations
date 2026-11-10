import type { TKey } from '@/lib/i18n';
import { moneyInput } from '@/lib/money';
import type { StayUnit } from '@/lib/types';
import { saveStayUnit } from '@/app/stays-actions';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

/** Create (no `unit`) or edit a unit. Posts to saveStayUnit. */
export default function UnitForm({
  unit,
  currency,
  t,
}: {
  unit?: StayUnit;
  currency: string;
  t: (key: TKey, vars?: Record<string, string>) => string;
}) {
  const id = unit ? `u-${unit.id}` : 'new';
  return (
    <form
      action={saveStayUnit}
      className="space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
    >
      {unit && <input type="hidden" name="id" value={unit.id} />}
      <div>
        <label htmlFor={`${id}-name`} className={label}>{t('stay.units.name')}</label>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={120}
          defaultValue={unit?.name}
          placeholder={t('stay.units.namePlaceholder')}
          className={input}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${id}-price`} className={label}>
            {t('stay.units.price', { currency })}
          </label>
          <input
            id={`${id}-price`}
            name="price"
            type="number"
            min={0}
            step="0.01"
            required
            defaultValue={unit ? moneyInput(unit.base_price_cents) : ''}
            className={input}
          />
        </div>
        <div>
          <label htmlFor={`${id}-cleaning`} className={label}>
            {t('stay.units.cleaningFee', { currency })}
          </label>
          <input
            id={`${id}-cleaning`}
            name="cleaningFee"
            type="number"
            min={0}
            step="0.01"
            defaultValue={unit ? moneyInput(unit.cleaning_fee_cents) : '0.00'}
            className={input}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${id}-guests`} className={label}>{t('stay.units.maxGuests')}</label>
          <input
            id={`${id}-guests`}
            name="maxGuests"
            type="number"
            min={1}
            max={30}
            required
            defaultValue={unit?.max_guests ?? 2}
            className={input}
          />
        </div>
        <div>
          <label htmlFor={`${id}-min`} className={label}>{t('stay.units.minNights')}</label>
          <input
            id={`${id}-min`}
            name="minNights"
            type="number"
            min={1}
            max={90}
            required
            defaultValue={unit?.min_nights ?? 1}
            className={input}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-desc`} className={label}>{t('stay.units.description')}</label>
        <textarea
          id={`${id}-desc`}
          name="description"
          rows={2}
          maxLength={600}
          defaultValue={unit?.description ?? ''}
          placeholder={t('stay.units.descriptionPlaceholder')}
          className={input}
        />
      </div>
      {unit && (
        <label className="flex items-center gap-2 text-sm text-espresso">
          <input type="checkbox" name="active" defaultChecked={unit.active} className="tf-switch" />
          {t('stay.units.bookable')}
        </label>
      )}
      <button className="min-h-11 rounded-lg bg-espresso px-6 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
        {unit ? t('form.save') : t('stay.units.add')}
      </button>
    </form>
  );
}
