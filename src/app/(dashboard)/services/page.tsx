import Link from 'next/link';
import { Clock, Scissors } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { deleteService, saveService } from '@/app/appointments-actions';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney, moneyInput } from '@/lib/money';
import { currencyOf, type Service, type StaffService } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; deleted?: string; edit?: string }>;
}) {
  const { error, saved, deleted, edit } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  const lang = asLang(business.language);
  const t = getT(lang);
  const currency = currencyOf(business);

  const [{ data: services }, { data: links }] = await Promise.all([
    supabase.from('services').select('*').order('sort').order('name').returns<Service[]>(),
    supabase.from('staff_services').select('*').returns<StaffService[]>(),
  ]);
  const all = services ?? [];
  const editing = all.find((s) => s.id === edit) ?? null;
  const staffCount = (serviceId: string) => (links ?? []).filter((l) => l.service_id === serviceId).length;
  const categories = Array.from(new Set(all.map((s) => s.category ?? ''))).sort((a, b) => a.localeCompare(b));

  return (
    <div className="tf-rise">
      <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">{t('svc.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">{t('svc.subtitle')}</p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}
      {(saved || deleted) && (
        <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">
          {deleted ? t('svc.deleted') : t('common.saved')}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {all.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-linen bg-white p-14 text-center text-sm text-espresso/40 shadow-card">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                <Scissors size={24} aria-hidden className="text-caramel" />
              </span>
              {t('svc.empty')}
            </div>
          )}
          {categories.map((category) => (
            <section
              key={category || '-'}
              className="overflow-hidden rounded-2xl border border-linen bg-white shadow-card"
            >
              <header className="border-b border-linen bg-sand/50 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-espresso/60">
                {category || t('svc.noCategory')}
              </header>
              <ul className="divide-y divide-linen/60">
                {all
                  .filter((s) => (s.category ?? '') === category)
                  .map((s) => (
                    <li
                      key={s.id}
                      className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-sand/30 ${
                        s.active ? '' : 'text-espresso/40'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-espresso">
                          {s.name}
                          {!s.active && (
                            <span className="ml-2 rounded-md bg-espresso/10 px-1.5 py-0.5 text-xs font-semibold text-espresso/50">
                              {t('common.inactive')}
                            </span>
                          )}
                          {s.active && staffCount(s.id) === 0 && (
                            <span className="ml-2 rounded-md bg-wine/10 px-1.5 py-0.5 text-xs font-semibold text-wine">
                              {t('svc.noStaff')}
                            </span>
                          )}
                        </p>
                        <p className="tabular mt-0.5 flex items-center gap-1.5 text-xs text-espresso/50">
                          <Clock size={12} aria-hidden />
                          {t('appt.minutes', { n: String(s.duration_minutes) })}
                          {s.buffer_minutes > 0 &&
                            ` + ${t('appt.minutes', { n: String(s.buffer_minutes) })} ${t('svc.bufferShort')}`}
                          {s.description ? ` · ${s.description}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="tabular font-serif text-lg font-semibold text-espresso">
                          {formatMoney(s.price_cents, currency, lang)}
                        </span>
                        <Link
                          href={`/services?edit=${s.id}`}
                          className="min-h-11 content-center text-xs font-semibold text-caramel transition hover:text-terracotta"
                        >
                          {t('common.edit')}
                        </Link>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>

        <div>
          <form
            key={editing?.id ?? 'new'}
            action={saveService}
            className="space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
          >
            <h2 className="font-serif text-lg font-semibold text-espresso">
              {editing ? t('svc.edit') : t('svc.add')}
            </h2>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div>
              <label htmlFor="name" className={label}>{t('common.name')}</label>
              <input id="name" name="name" required maxLength={120} defaultValue={editing?.name} className={input} />
            </div>
            <div>
              <label htmlFor="category" className={label}>
                {t('svc.category')} <span className="font-normal text-espresso/40">({t('common.optional')})</span>
              </label>
              <input
                id="category"
                name="category"
                list="service-categories"
                maxLength={80}
                defaultValue={editing?.category ?? ''}
                className={input}
              />
              <datalist id="service-categories">
                {categories.filter(Boolean).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="duration" className={label}>{t('svc.duration')}</label>
                <input
                  id="duration"
                  name="duration"
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  required
                  defaultValue={editing?.duration_minutes ?? 30}
                  className={input}
                />
              </div>
              <div>
                <label htmlFor="buffer" className={label}>{t('svc.buffer')}</label>
                <input
                  id="buffer"
                  name="buffer"
                  type="number"
                  min={0}
                  max={120}
                  step={5}
                  defaultValue={editing?.buffer_minutes ?? 0}
                  className={input}
                />
              </div>
            </div>
            <p className="!mt-1.5 text-xs text-espresso/50">{t('svc.bufferHint')}</p>
            <div>
              <label htmlFor="price" className={label}>
                {t('common.price')} ({currency})
              </label>
              <input
                id="price"
                name="price"
                type="number"
                min={0}
                step="0.01"
                required
                defaultValue={moneyInput(editing?.price_cents)}
                className={input}
              />
            </div>
            <div>
              <label htmlFor="description" className={label}>
                {t('svc.description')}{' '}
                <span className="font-normal text-espresso/40">({t('common.optional')})</span>
              </label>
              <textarea
                id="description"
                name="description"
                rows={2}
                maxLength={300}
                defaultValue={editing?.description ?? ''}
                className={input}
              />
            </div>
            <label className="flex items-center gap-2.5 text-sm text-espresso">
              <input type="checkbox" name="active" defaultChecked={editing?.active ?? true} className="tf-switch" />
              {t('svc.active')}
            </label>
            <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
              {editing ? t('form.save') : t('svc.add')}
            </button>
            {editing && (
              <Link
                href="/services"
                className="block min-h-9 content-center text-center text-xs font-semibold text-espresso/50 transition hover:text-espresso"
              >
                {t('common.cancel')}
              </Link>
            )}
          </form>
          {editing && (
            <form action={deleteService.bind(null, editing.id)} className="mt-3 text-right">
              <button className="min-h-9 text-xs font-semibold text-wine transition hover:opacity-70">
                {t('svc.delete')}
              </button>
              <p className="text-xs text-espresso/50">{t('svc.deleteHint')}</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
