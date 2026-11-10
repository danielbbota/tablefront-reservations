import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { amountDueOnline } from '../money';
import {
  PAYMENT_HOLD_MINUTES,
  type Appointment,
  type Lang,
  type PaymentAccount,
  type Restaurant,
  type StayReservation,
} from '../types';
import {
  createCheckoutSession,
  expireCheckoutSession,
  paymentsConfigured,
  retrieveCheckoutSession,
  type CheckoutSession,
} from './stripe';

/**
 * Online payment for stays and appointments. A paid booking is first written
 * as a `pending_payment` hold (by the create_* database functions), then the
 * guest is sent to Stripe Checkout on the business's own Stripe account. The
 * webhook (or the /pay return page, whichever comes first) flips the hold to
 * `confirmed`. Holds that are never paid simply run out.
 */

export type PayableKind = 'stay' | 'appointment';
export const PAYABLE_TABLE: Record<PayableKind, 'stay_reservations' | 'appointments'> = {
  stay: 'stay_reservations',
  appointment: 'appointments',
};

export type PaymentSetup = { account: PaymentAccount; mode: 'deposit' | 'full'; depositPercent: number };

/**
 * The business's payment setup, or null when the guest should not be charged
 * online: payment mode off, Stripe not configured on the platform, or the
 * business has not finished connecting Stripe. In all of those the booking is
 * confirmed without payment rather than blocked.
 */
export async function getPaymentSetup(
  supabase: SupabaseClient,
  business: Restaurant
): Promise<PaymentSetup | null> {
  const mode = business.payment_mode;
  if ((mode !== 'deposit' && mode !== 'full') || !paymentsConfigured()) return null;
  const { data: account } = await supabase
    .from('payment_accounts')
    .select('*')
    .eq('restaurant_id', business.id)
    .maybeSingle<PaymentAccount>();
  if (!account?.charges_enabled) return null;
  return { account, mode, depositPercent: business.deposit_percent ?? 30 };
}

/** Amount to charge now and the hold length to pass to the create_* function. */
export function paymentTerms(totalCents: number, setup: PaymentSetup | null) {
  const due = setup ? amountDueOnline(totalCents, setup.mode, setup.depositPercent) : 0;
  return { amountDueCents: due, holdMinutes: due > 0 ? PAYMENT_HOLD_MINUTES : 0 };
}

const STRIPE_LOCALE: Record<Lang, string> = { en: 'en', pt: 'pt', de: 'de', fr: 'fr' };

export type CheckoutRequest = {
  kind: PayableKind;
  id: string;
  cancelToken: string;
  amountCents: number;
  currency: string;
  title: string;
  description?: string;
  email?: string;
  lang: Lang;
};

/**
 * Create the Checkout Session for a fresh hold and remember it on the row.
 * If Stripe refuses, the hold is cancelled so the dates / slot are free again
 * and the error is rethrown for the API to report.
 */
export async function startCheckout(
  supabase: SupabaseClient,
  setup: PaymentSetup,
  req: CheckoutRequest,
  appUrl: string
): Promise<string> {
  const table = PAYABLE_TABLE[req.kind];
  try {
    const session = await createCheckoutSession({
      account: setup.account.stripe_account_id,
      amountCents: req.amountCents,
      currency: req.currency,
      productName: req.title,
      description: req.description,
      customerEmail: req.email,
      successUrl: `${appUrl}/pay/${req.cancelToken}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/pay/${req.cancelToken}?cancelled=1`,
      metadata: { kind: req.kind, id: req.id },
      // Stripe's minimum is 30 minutes; the hold outlives the session by a few
      // minutes so a payment made at the last second still finds its dates.
      expiresAt: Math.floor(Date.now() / 1000) + (PAYMENT_HOLD_MINUTES - 4) * 60,
      locale: STRIPE_LOCALE[req.lang],
      idempotencyKey: `checkout-${req.kind}-${req.id}`,
    });
    if (!session.url) throw new Error('Stripe returned no checkout URL.');
    await supabase.from(table).update({ stripe_session_id: session.id }).eq('id', req.id);
    return session.url;
  } catch (err) {
    await supabase
      .from(table)
      .update({ status: 'cancelled', payment_status: 'none', hold_expires_at: null })
      .eq('id', req.id)
      .eq('status', 'pending_payment');
    throw err;
  }
}

type PayableRow = StayReservation | Appointment;

/**
 * Flip a paid hold to confirmed. Idempotent: returns the row only the first
 * time (when it was still pending), so the caller sends emails exactly once.
 */
export async function confirmPaid<T extends PayableRow>(
  supabase: SupabaseClient,
  kind: PayableKind,
  session: Pick<CheckoutSession, 'id' | 'payment_status' | 'amount_total'>
): Promise<T | null> {
  if (session.payment_status !== 'paid') return null;
  const { data } = await supabase
    .from(PAYABLE_TABLE[kind])
    .update({
      status: 'confirmed',
      payment_status: 'paid',
      paid_cents: session.amount_total ?? 0,
      hold_expires_at: null,
    })
    .eq('stripe_session_id', session.id)
    .eq('status', 'pending_payment')
    .select()
    .maybeSingle<T>();
  return data ?? null;
}

/** The guest abandoned or the session expired: free the dates / slot now. */
export async function releaseHold(supabase: SupabaseClient, kind: PayableKind, sessionId: string) {
  await supabase
    .from(PAYABLE_TABLE[kind])
    .update({ status: 'cancelled', payment_status: 'none', hold_expires_at: null })
    .eq('stripe_session_id', sessionId)
    .eq('status', 'pending_payment');
}

/** Ask Stripe about a session (used by the /pay return page when the webhook is slow). */
export async function fetchSession(account: string, sessionId: string): Promise<CheckoutSession | null> {
  try {
    return await retrieveCheckoutSession(account, sessionId);
  } catch (err) {
    console.error('[payments] could not retrieve session', sessionId, err);
    return null;
  }
}

/** Best-effort: stop an open session from being paid after we gave the hold up. */
export async function expireSession(account: string, sessionId: string) {
  try {
    await expireCheckoutSession(account, sessionId);
  } catch {
    // Already complete or expired: nothing to do.
  }
}
