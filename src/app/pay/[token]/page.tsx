import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeSlot } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { confirmPaid, fetchSession, type PayableKind } from '@/lib/payments/checkout';
import { notifyConfirmed } from '@/lib/payments/notify';
import { isLive } from '@/lib/stays/availability';
import type { Appointment, PaymentAccount, Restaurant, StayReservation } from '@/lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where Stripe Checkout sends the guest back (success or "back" button), and
 * a page they can reopen to finish paying. Public: the booking's unguessable
 * cancel_token is the credential.
 *
 * On a successful return it asks Stripe directly whether the session is paid
 * and confirms the booking, so the guest never waits on the webhook. Both
 * paths are idempotent: whichever comes first confirms and sends the emails.
 */
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { token } = await params;
  const { session_id: sessionId } = await searchParams;

  const card = (children: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="tf-rise w-full max-w-md rounded-2xl border border-linen bg-white p-8 shadow-lift">
        {children}
      </div>
    </main>
  );
  const notFound = card(<p className="text-sm text-espresso">{getT('en')('pay.page.notFound')}</p>);
  if (!UUID_RE.test(token)) return notFound;

  const supabase = createAdminClient();
  const load = async (): Promise<{ kind: PayableKind; row: StayReservation | Appointment } | null> => {
    const { data: stay } = await supabase
      .from('stay_reservations')
      .select('*')
      .eq('cancel_token', token)
      .maybeSingle<StayReservation>();
    if (stay) return { kind: 'stay', row: stay };
    const { data: appt } = await supabase
      .from('appointments')
      .select('*')
      .eq('cancel_token', token)
      .maybeSingle<Appointment>();
    return appt ? { kind: 'appointment', row: appt } : null;
  };

  let found = await load();
  if (!found) return notFound;

  const [{ data: business }, { data: account }] = await Promise.all([
    supabase.from('restaurants').select('*').eq('id', found.row.restaurant_id).maybeSingle<Restaurant>(),
    supabase
      .from('payment_accounts')
      .select('*')
      .eq('restaurant_id', found.row.restaurant_id)
      .maybeSingle<PaymentAccount>(),
  ]);
  if (!business) return notFound;

  // Still a hold: look at its Stripe session. Only the session stored on the
  // row counts; a session id from the URL is used solely to match it.
  let resumeUrl: string | null = null;
  const stored = found.row.stripe_session_id;
  if (found.row.status === 'pending_payment' && stored && account && (!sessionId || sessionId === stored)) {
    const session = await fetchSession(account.stripe_account_id, stored);
    if (session?.payment_status === 'paid') {
      const confirmed = await confirmPaid<StayReservation | Appointment>(supabase, found.kind, session);
      if (confirmed) await notifyConfirmed(supabase, found.kind, confirmed);
      found = (await load()) ?? found;
    } else if (session?.status === 'open') {
      resumeUrl = session.url;
    }
  }

  const { kind, row } = found;
  const lang = asLang(row.guest_lang);
  const t = getT(lang);
  const holdLive = row.status === 'pending_payment' && isLive(row);

  const summary = (
    <div className="mt-4 space-y-1 rounded-lg bg-sand/60 p-4 text-sm text-espresso">
      <p className="font-serif text-base font-semibold">{business.name}</p>
      {kind === 'stay' ? (
        <p>
          {(row as StayReservation).check_in} → {(row as StayReservation).check_out}
        </p>
      ) : (
        <p>
          {(row as Appointment).service_name} · {(row as Appointment).date} ·{' '}
          {normalizeSlot((row as Appointment).start_time)}
        </p>
      )}
      <p className="text-espresso/60">{row.guest_name}</p>
      {row.paid_cents > 0 && (
        <p className="font-medium text-leaf">
          {t('pay.paidOnline')}: {formatMoney(row.paid_cents, row.currency, lang)}
        </p>
      )}
      {row.status === 'pending_payment' && row.amount_due_cents > 0 && (
        <p className="font-medium">
          {t('pay.dueNow')}: {formatMoney(row.amount_due_cents, row.currency, lang)}
        </p>
      )}
    </div>
  );

  const title = <h1 className="font-serif text-xl font-semibold text-espresso">{t('pay.page.title')}</h1>;

  if (row.status === 'confirmed') {
    return card(
      <>
        {title}
        <p className="mt-3 rounded-lg bg-leaf/10 px-4 py-3 text-sm text-leaf">{t('pay.page.confirmed')}</p>
        {summary}
      </>
    );
  }

  if (holdLive && resumeUrl) {
    return card(
      <>
        {title}
        <p className="mt-3 text-sm text-espresso/70">{t('pay.page.pending')}</p>
        {summary}
        <a
          href={resumeUrl}
          className="mt-5 flex min-h-11 w-full items-center justify-center rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta"
        >
          {t('pay.page.resume')}
        </a>
      </>
    );
  }

  return card(
    <>
      {title}
      <p className="mt-3 text-sm text-espresso/70">{t('pay.page.expired')}</p>
      {summary}
    </>
  );
}
