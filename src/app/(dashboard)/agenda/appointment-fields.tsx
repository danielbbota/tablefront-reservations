import type { getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import type { Lang, Service, Staff } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

export type AppointmentDefaults = {
  serviceId?: string;
  staffId?: string;
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
};

/**
 * The fields shared by "new appointment" and "edit appointment". Services are
 * grouped by category; `keepService` adds a first option that keeps a booked
 * service that has since been deleted or changed.
 */
export default function AppointmentFields({
  t,
  lang,
  currency,
  services,
  staff,
  stepMinutes,
  defaults = {},
  keepService,
}: {
  t: ReturnType<typeof getT>;
  lang: Lang;
  currency: string;
  services: Service[];
  staff: Staff[];
  stepMinutes: number;
  defaults?: AppointmentDefaults;
  keepService?: string;
}) {
  const categories = Array.from(new Set(services.map((s) => s.category ?? ''))).sort((a, b) =>
    a.localeCompare(b)
  );
  const option = (s: Service) => (
    <option key={s.id} value={s.id}>
      {s.name} · {t('appt.minutes', { n: String(s.duration_minutes) })} ·{' '}
      {formatMoney(s.price_cents, currency, lang)}
    </option>
  );

  return (
    <>
      <div>
        <label htmlFor="serviceId" className={label}>{t('appt.service')}</label>
        <select
          id="serviceId"
          name="serviceId"
          required={!keepService}
          defaultValue={defaults.serviceId ?? ''}
          className={input}
        >
          {keepService ? <option value="">{keepService}</option> : <option value="" disabled>—</option>}
          {categories.map((c) =>
            c ? (
              <optgroup key={c} label={c}>
                {services.filter((s) => (s.category ?? '') === c).map(option)}
              </optgroup>
            ) : (
              services.filter((s) => !s.category).map(option)
            )
          )}
        </select>
      </div>
      <div>
        <label htmlFor="staffId" className={label}>{t('appt.staff')}</label>
        <select id="staffId" name="staffId" required defaultValue={defaults.staffId ?? ''} className={input}>
          <option value="" disabled>—</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.title ? ` · ${s.title}` : ''}
              {s.active ? '' : ` (${t('common.inactive')})`}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="date" className={label}>{t('form.date')}</label>
          <input id="date" name="date" type="date" required defaultValue={defaults.date} className={input} />
        </div>
        <div>
          <label htmlFor="time" className={label}>{t('form.time')}</label>
          <input
            id="time"
            name="time"
            type="time"
            required
            step={stepMinutes * 60}
            defaultValue={defaults.time}
            className={input}
          />
        </div>
      </div>
      <div>
        <label htmlFor="name" className={label}>{t('appt.clientName')}</label>
        <input id="name" name="name" required maxLength={120} defaultValue={defaults.name} className={input} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="phone" className={label}>{t('form.phone')}</label>
          <input id="phone" name="phone" maxLength={40} defaultValue={defaults.phone} className={input} />
        </div>
        <div>
          <label htmlFor="email" className={label}>{t('form.email')}</label>
          <input id="email" name="email" type="email" defaultValue={defaults.email} className={input} />
        </div>
      </div>
      <div>
        <label htmlFor="notes" className={label}>{t('form.notes')}</label>
        <textarea id="notes" name="notes" rows={2} defaultValue={defaults.notes} className={input} />
      </div>
    </>
  );
}
