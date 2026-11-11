import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, Info } from 'lucide-react';
import { requireBusiness } from '@/lib/business';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney, moneyInput } from '@/lib/money';
import { isLive } from '@/lib/stays/availability';
import { guestLabel, isChannelSource, sourceLabel } from '@/lib/stays/display';
import { setStayReservationStatus, updateStayReservation } from '@/app/stays-actions';
import { currencyOf, type StayReservation, type StayUnit } from '@/lib/types';

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30 disabled:bg-sand/60 disabled:text-espresso/60';
const label = 'block text-sm font-medium text-espresso';

export default async function EditStayReservationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { supabase, business } = await requireBusiness('stays');
  const lang = asLang(business.language);
  const t = getT(lang);

  const [{ data: res }, { data: units }] = await Promise.all([
    supabase.from('stay_reservations').select('*').eq('id', id).maybeSingle<StayReservation>(),
    supabase.from('stay_units').select('*').order('sort').order('name').returns<StayUnit[]>(),
  ]);
  if (!res) notFound();

  const channel = isChannelSource(res.source);
  const channelName = sourceLabel(res.source, t);
  const pendingLive = res.status === 'pending_payment' && isLive(res);

  return (
    <div className="tf-rise max-w-lg">
      <Link href="/stays/reservations" className="text-xs font-semibold text-caramel hover:text-terracotta">
        ← {t('nav.stays.reservations')}
      </Link>
      <h1 className="mt-2 font-serif text-2xl font-semibold text-espresso">{t('stay.edit.title')}</h1>
      <p className="mt-1.5 text-sm text-espresso/60">
        {guestLabel(res, t)} · {channelName}
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-wine/10 px-4 py-2.5 text-sm text-wine">
          {error}
        </p>
      )}

      {channel && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-caramel/15 px-4 py-3 text-sm text-espresso">
          <Info size={16} aria-hidden className="mt-0.5 flex-none text-terracotta" />
          <div>
            <p>{t('stay.edit.channelNote', { channel: channelName })}</p>
            {res.external_ref && /^https:\/\//.test(res.external_ref) && (
              <a
                href={res.external_ref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-semibold text-terracotta underline"
              >
                {t('stay.edit.openOnChannel', { channel: channelName })}
                <ExternalLink size={13} aria-hidden />
              </a>
            )}
          </div>
        </div>
      )}

      {(res.paid_cents > 0 || pendingLive) && (
        <p className="mt-4 rounded-lg bg-leaf/10 px-4 py-2.5 text-sm text-leaf">
          {pendingLive
            ? `${t('status.pending_payment')}: ${formatMoney(res.amount_due_cents, res.currency, lang)}`
            : `${t('pay.paidOnline')}: ${formatMoney(res.paid_cents, res.currency, lang)}`}
        </p>
      )}

      <form
        action={updateStayReservation.bind(null, res.id)}
        className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
      >
        <div>
          <label htmlFor="unitId" className={label}>{t('stay.unit')}</label>
          <select id="unitId" name="unitId" defaultValue={res.unit_id} disabled={channel} className={input}>
            {(units ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="checkIn" className={label}>{t('stay.checkIn')}</label>
            <input id="checkIn" name="checkIn" type="date" required defaultValue={res.check_in} disabled={channel} className={input} />
          </div>
          <div>
            <label htmlFor="checkOut" className={label}>{t('stay.checkOut')}</label>
            <input id="checkOut" name="checkOut" type="date" required defaultValue={res.check_out} disabled={channel} className={input} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="guests" className={label}>{t('stay.guests')}</label>
            <input id="guests" name="guests" type="number" min={1} max={30} required defaultValue={res.guests} className={input} />
          </div>
          <div>
            <label htmlFor="total" className={label}>
              {t('stay.form.total', { currency: currencyOf(business) })}
            </label>
            <input id="total" name="total" type="number" min={0} step="0.01" defaultValue={moneyInput(res.total_cents)} className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="name" className={label}>{t('form.name')}</label>
          <input id="name" name="name" required defaultValue={res.guest_name} className={input} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="phone" className={label}>{t('form.phone')}</label>
            <input id="phone" name="phone" defaultValue={res.guest_phone} className={input} />
          </div>
          <div>
            <label htmlFor="email" className={label}>{t('form.email')}</label>
            <input id="email" name="email" type="email" defaultValue={res.guest_email} className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="notes" className={label}>{t('form.notes')}</label>
          <textarea id="notes" name="notes" rows={3} defaultValue={res.notes ?? ''} className={input} />
        </div>
        <button className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99]">
          {t('form.save')}
        </button>
      </form>

      {!channel && res.status !== 'cancelled' && (
        <form action={setStayReservationStatus.bind(null, res.id, 'cancelled')} className="mt-4">
          <button className="min-h-11 w-full rounded-lg border border-wine/30 px-4 py-2.5 text-sm font-semibold text-wine transition hover:bg-wine/10">
            {t('stay.edit.cancel')}
          </button>
          <p className="mt-2 text-xs text-espresso/50">{t('stay.list.note')}</p>
        </form>
      )}
    </div>
  );
}
