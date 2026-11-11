import Link from 'next/link';
import { Users } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { saveStaff } from '@/app/appointments-actions';
import { asLang, getT } from '@/lib/i18n';
import type { Service, Staff, StaffService } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

/** Preset colours for new professionals (brand palette first). */
const COLORS = ['#c9954a', '#8c4225', '#4a7c4e', '#7c3a3a', '#3f6f8f', '#7a5c99', '#b8683a', '#4f7f78'];

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; deleted?: string; deactivated?: string }>;
}) {
  const { error, saved, deleted, deactivated } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  const t = getT(asLang(business.language));

  const [{ data: staff }, { data: services }, { data: links }] = await Promise.all([
    supabase.from('staff').select('*').order('sort').order('name').returns<Staff[]>(),
    supabase.from('services').select('*').order('sort').order('name').returns<Service[]>(),
    supabase.from('staff_services').select('*').returns<StaffService[]>(),
  ]);
  const team = staff ?? [];
  const notice = deactivated ? t('team.deactivated') : deleted ? t('team.deleted') : saved ? t('common.saved') : null;

  return (
    <div className="tf-rise">
      <h1 className="font-serif text-[1.7rem] font-semibold tracking-tight text-espresso">{t('team.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">{t('team.subtitle')}</p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}
      {notice && <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{notice}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div>
          {team.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-linen bg-white p-14 text-center text-sm text-espresso/40 shadow-card">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sand">
                <Users size={24} aria-hidden className="text-caramel" />
              </span>
              {t('team.empty')}
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {team.map((s) => {
                const count = (links ?? []).filter((l) => l.staff_id === s.id).length;
                return (
                  <li key={s.id}>
                    <Link
                      href={`/team/${s.id}`}
                      className={`tf-lift flex items-center gap-4 rounded-2xl border border-linen bg-white p-5 shadow-card ${
                        s.active ? '' : 'opacity-60'
                      }`}
                    >
                      <span
                        aria-hidden
                        className="flex h-12 w-12 flex-none items-center justify-center rounded-full font-serif text-lg font-semibold text-white"
                        style={{ backgroundColor: s.color }}
                      >
                        {s.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-espresso">
                          {s.name}
                          {!s.active && (
                            <span className="ml-2 rounded-md bg-espresso/10 px-1.5 py-0.5 text-xs font-semibold text-espresso/50">
                              {t('common.inactive')}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-espresso/50">
                          {s.title ? `${s.title} · ` : ''}
                          {t('team.serviceCount', { n: String(count) })} ·{' '}
                          {s.working_hours ? t('team.ownHoursShort') : t('team.businessHoursShort')}
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form
          action={saveStaff}
          className="space-y-4 self-start rounded-2xl border border-linen bg-white p-6 shadow-card"
        >
          <h2 className="font-serif text-lg font-semibold text-espresso">{t('team.add')}</h2>
          <div>
            <label htmlFor="name" className={label}>{t('common.name')}</label>
            <input id="name" name="name" required maxLength={120} className={input} />
          </div>
          <div>
            <label htmlFor="title" className={label}>
              {t('team.role')} <span className="font-normal text-espresso/40">({t('common.optional')})</span>
            </label>
            <input id="title" name="title" maxLength={80} className={input} />
          </div>
          <div>
            <label htmlFor="color" className={label}>{t('team.color')}</label>
            <input
              id="color"
              name="color"
              type="color"
              defaultValue={COLORS[team.length % COLORS.length]}
              className="mt-1 h-11 w-20 cursor-pointer rounded-lg border border-linen bg-white p-1"
            />
          </div>
          <fieldset>
            <legend className={label}>{t('team.services')}</legend>
            {(services ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-espresso/50">{t('team.noServices')}</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {(services ?? []).map((svc) => (
                  <label key={svc.id} className="flex items-center gap-2.5 text-sm text-espresso">
                    <input
                      type="checkbox"
                      name="services"
                      value={svc.id}
                      defaultChecked
                      className="h-4 w-4 accent-[var(--tf-terracotta)]"
                    />
                    {svc.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <p className="text-xs text-espresso/50">{t('team.addHint')}</p>
          <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
            {t('team.add')}
          </button>
        </form>
      </div>
    </div>
  );
}
