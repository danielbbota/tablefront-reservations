import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Stripe client over fetch (no SDK dependency): Connect onboarding,
 * Checkout Sessions as direct charges on the business's own Stripe account,
 * and webhook signature verification.
 *
 * Project rule: test mode only. A live key (sk_live_…) is ignored, which
 * turns online payment off everywhere instead of charging real cards.
 */

const API = 'https://api.stripe.com/v1';

export function stripeKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  return key && key.startsWith('sk_test_') ? key : null;
}

export function paymentsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return stripeKey(env) !== null;
}

export class StripeError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

type Params = { [key: string]: string | number | boolean | null | undefined | Params | Params[] };

/** Stripe's form encoding: {a: {b: [ {c: 1} ]}} → a[b][0][c]=1 */
export function encodeParams(params: Params, prefix = ''): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => out.push(encodeParams(item, `${name}[${i}]`)));
    } else if (typeof value === 'object') {
      out.push(encodeParams(value, name));
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out.filter(Boolean).join('&');
}

async function stripeRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { params?: Params; account?: string; idempotencyKey?: string } = {}
): Promise<T> {
  const key = stripeKey();
  if (!key) throw new StripeError('Stripe is not configured (test key missing).', 500);

  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (opts.account) headers['Stripe-Account'] = opts.account;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: method === 'POST' ? encodeParams(opts.params ?? {}) : undefined,
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!res.ok || !body) {
    throw new StripeError(body?.error?.message ?? `Stripe answered HTTP ${res.status}`, res.status, body?.error?.code);
  }
  return body as T;
}

export type StripeAccount = { id: string; charges_enabled: boolean; details_submitted: boolean };

/** A Standard connected account: the business owns it and is the merchant. */
export function createConnectedAccount(email: string, businessName: string) {
  return stripeRequest<StripeAccount>('POST', '/accounts', {
    params: { type: 'standard', email, business_profile: { name: businessName } },
  });
}

export function retrieveAccount(accountId: string) {
  return stripeRequest<StripeAccount>('GET', `/accounts/${encodeURIComponent(accountId)}`);
}

export function createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
  return stripeRequest<{ url: string }>('POST', '/account_links', {
    params: { account: accountId, type: 'account_onboarding', return_url: returnUrl, refresh_url: refreshUrl },
  });
}

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  metadata: Record<string, string> | null;
};

export type CheckoutInput = {
  account: string;
  amountCents: number;
  currency: string;
  productName: string;
  description?: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  /** Unix seconds. Stripe requires 30 minutes to 24 hours from now. */
  expiresAt: number;
  locale?: string;
  idempotencyKey?: string;
};

/** A direct charge on the connected account: no platform fee, no commission. */
export function createCheckoutSession(input: CheckoutInput) {
  return stripeRequest<CheckoutSession>('POST', '/checkout/sessions', {
    account: input.account,
    idempotencyKey: input.idempotencyKey,
    params: {
      mode: 'payment',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      customer_email: input.customerEmail || undefined,
      expires_at: input.expiresAt,
      locale: input.locale,
      metadata: input.metadata,
      payment_intent_data: { metadata: input.metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents,
            product_data: { name: input.productName, description: input.description || undefined },
          },
        },
      ],
    },
  });
}

export function retrieveCheckoutSession(account: string, sessionId: string) {
  return stripeRequest<CheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    account,
  });
}

export function expireCheckoutSession(account: string, sessionId: string) {
  return stripeRequest<CheckoutSession>(
    'POST',
    `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    { account }
  );
}

/**
 * Verify a `Stripe-Signature` header ("t=<unix>,v1=<hex>[,v1=<hex>…]") against
 * the raw request body. Rejects stale timestamps to stop replays.
 */
export function verifyWebhookSignature(
  payload: string,
  header: string | null,
  secret: string | undefined,
  toleranceSeconds = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
