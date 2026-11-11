import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarOff, Clock } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { addTimeOff, deleteStaff, deleteTimeOff, saveStaff } from '@/app/appointments-actions';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { UUID_RE } from '@/lib/appointments/data';
import { asLang, getT, type TKey } from '@/lib/i18n';
import type { Service, Staff, StaffService, StaffTimeOff } from '@/lib/types';

const input =
  'rounded-lg border border-linen bg-white px-2.5 py-2 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const { supabase, business } = await requireBusiness('appointments');
  if (!UUID_RE.test(id)) notFound();
  const t = getT(asLang(business.language));
  const today = nowInTimezone(business.timezone).date;

  const [{ data: member }, { data: services }, { data: links }, { data: timeOff }] = await Promise.all([
    supabase.from('staff').select('*').eq('id', id).maybeSingle<Staff>(),
    supabase.from('services').select('*').order('sort').order('name').returns<Service[]>(),
    supabase.from('staff_services').select('*').eq('staff_id', id).returns<StaffService[]>(),
    supabase
      .from('staff_time_off')
      .select('*')
      .eq('staff_id', id)
      .gte('date', today)
      .order('date')
      .returns<StaffTimeOff[]>(),
  ]);
  if (!member) notFound();

  const performs = new Set((links ?? []).map((l) => l.service_id));
  // The grid starts from the professional's own hours, or the business's.
  const hours = member.working_hours ?? business.operating_hours ?? {};

  return (
    <div className="tf-rise max-w-2xl space-y-6">
      <div>
        <Link
          href="/team"
          className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-caramel transition hover:text-terracotta"
        >
          <ArrowLeft size={14} aria-hidden />
          {t('team.title')}
        </Link>
        <h1 className="mt-1 flex items-center gap-3 font-serif text-2xl font-semibold text-espresso">
          <span aria-hidden className="h-4 w-4 rounded-full" style={{ backgroundColor: member.color }} />
          {member.name}
        </h1>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}
      {saved && <p className="rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">{t('common.saved')}</p>}

      <form action={saveStaff} className="space-y-6 rounded-2xl border border-linen bg-white p-6 shadow-card">
        <input type="hidden" name="id" value={member.id} />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="name" className={label}>{t('common.name')}</label>
            <input
              id="name"
              name="name"
              required
              maxLength={120}
              defaultValue={member.name}
              className={`${input} mt-1 w-full`}
            />
          </div>
          <div>
            <label htmlFor="title" className={label}>
              {t('team.role')} <span className="font-normal text-espresso/40">({t('common.optional')})</span>
            </label>
            <input
              id="title"
              name="title"
              maxLength={80}
              defaultValue={member.title ?? ''}
              className={`${input} mt-1 w-full`}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <label htmlFor="color" className={label}>{t('team.color')}</label>
            <input
              id="color"
              name="color"
              type="color"
              defaultValue={member.color}
              className="mt-1 h-11 w-20 cursor-pointer rounded-lg border border-linen bg-white p-1"
            />
          </div>
          <label className="flex min-h-11 items-center gap-2.5 text-sm text-espresso">
            <input type="checkbox" name="active" defaultChecked={member.active} className="tf-switch" />
            {t('team.active')}
          </label>
        </div>

        <fieldset>
          <legend className={label}>{t('team.services')}</legend>
          {(services ?? []).length === 0 ? (
            <p className="mt-1 text-xs text-espresso/50">{t('team.noServices')}</p>
          ) : (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {(services ?? []).map((svc) => (
                <label key={svc.id} className="flex items-center gap-2.5 text-sm text-espresso">
                  <input
                    type="checkbox"
                    name="services"
                    value={svc.id}
                    defaultChecked={performs.has(svc.id)}
                    className="h-4 w-4 accent-[var(--tf-terracotta)]"
                  />
                  {svc.name}
                  {!svc.active && <span className="text-xs text-espresso/40">({t('common.inactive')})</span>}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso">
            <Clock size={14} aria-hidden className="text-caramel" />
            {t('team.hoursTitle')}
          </h2>
          <label className="mt-2 flex items-center gap-2.5 text-sm text-espresso">
            <input
              type="checkbox"
              name="ownHours"
              defaultChecked={member.working_hours !== null}
              className="tf-switch"
            />
            {t('team.ownHours')}
          </label>
          <p className="mt-1 text-xs text-espresso/50">{t('team.ownHoursHint')}</p>
          <div className="mt-4 space-y-2.5">
            {Array.from({ length: 7 }, (_, d) => {
              const h = hours[String(d)] ?? { open: '09:00', close: '18:00', closed: true };
              return (
                <div
                  key={d}
                  className="grid grid-cols-[7.5rem_auto_1fr_1fr] items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-sand/40"
                >
                  <span className="text-sm text-espresso">{t(`days.${d}` as TKey)}</span>
                  <label className="flex items-center gap-1.5 text-xs text-espresso/60">
                    <input type="checkbox" name={`closed_${d}`} defaultChecked={h.closed} className="tf-switch" />
                    {t('team.dayOff')}
                  </label>
                  <input
                    type="time"
                    name={`open_${d}`}
                    defaultValue={h.open}
                    aria-label={`${t(`days.${d}` as TKey)} — ${t('common.from')}`}
                    className={input}
                  />
                  <input
                    type="time"
                    name={`close_${d}`}
                    defaultValue={h.close}
                    aria-label={`${t(`days.${d}` as TKey)} — ${t('common.to')}`}
                    className={input}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <button className="min-h-11 rounded-lg bg-espresso px-6 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
          {t('form.save')}
        </button>
      </form>

      <div className="rounded-2xl border border-linen bg-white p-6 shadow-card">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-espresso">
          <CalendarOff size={14} aria-hidden className="text-caramel" />
          {t('team.timeOff')}
        </h2>
        <p className="mt-1 text-xs text-espresso/50">{t('team.timeOffHint')}</p>

        {(timeOff ?? []).length > 0 && (
          <ul className="mt-4 divide-y divide-linen/60 rounded-lg border border-linen">
            {(timeOff ?? []).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-espresso">
                <span className="tabular">
                  {o.date} ·{' '}
                  {o.start_time && o.end_time
                    ? `${normalizeSlot(o.start_time)}–${normalizeSlot(o.end_time)}`
                    : t('team.allDay')}
                  {o.reason ? <span className="text-espresso/50"> · {o.reason}</span> : null}
                </span>
                <form action={deleteTimeOff.bind(null, o.id, member.id)}>
                  <button className="min-h-9 text-xs font-semibold text-wine transition hover:opacity-70">
                    {t('common.remove')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action={addTimeOff.bind(null, member.id)} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
          <div>
            <label htmlFor="off-date" className="block text-xs font-medium text-espresso/70">{t('form.date')}</label>
            <input id="off-date" name="date" type="date" required min={today} className={`${input} mt-1 w-full`} />
          </div>
          <div>
            <label htmlFor="off-start" className="block text-xs font-medium text-espresso/70">{t('common.from')}</label>
            <input id="off-start" name="start" type="time" className={`${input} mt-1 w-full`} />
          </div>
          <div>
            <label htmlFor="off-end" className="block text-xs font-medium text-espresso/70">{t('common.to')}</label>
            <input id="off-end" name="end" type="time" className={`${input} mt-1 w-full`} />
          </div>
          <label className="flex items-center gap-2.5 text-sm text-espresso sm:col-span-1">
            <input type="checkbox" name="allDay" className="tf-switch" />
            {t('team.allDay')}
          </label>
          <div className="sm:col-span-2">
            <input
              name="reason"
              maxLength={120}
              placeholder={t('team.reason')}
              aria-label={t('team.reason')}
              className={`${input} w-full`}
            />
          </div>
          <button className="min-h-11 rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99] sm:col-span-3">
            {t('team.addTimeOff')}
          </button>
        </form>
      </div>

      <form action={deleteStaff.bind(null, member.id)} className="text-right">
        <button className="min-h-9 text-xs font-semibold text-wine transition hover:opacity-70">
          {t('team.delete')}
        </button>
        <p className="text-xs text-espresso/50">{t('team.deleteHint')}</p>
      </form>
    </div>
  );
}
