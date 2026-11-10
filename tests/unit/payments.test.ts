// Money maths and the Stripe plumbing that can be proven without Stripe:
// what is charged online, form encoding, webhook signatures, test-mode rule.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { amountDueOnline, formatMoney, moneyInput, parseMoney } from '@/lib/money';
import { encodeParams, paymentsConfigured, stripeKey, verifyWebhookSignature } from '@/lib/payments/stripe';
import { paymentTerms, type PaymentSetup } from '@/lib/payments/checkout';
import { PAYMENT_HOLD_MINUTES } from '@/lib/types';

describe('parseMoney / moneyInput', () => {
  it.each([
    ['85', 8500],
    ['85.5', 8550],
    ['85,50', 8550],
    [' 1 250,00 ', 125000],
    ['0', 0],
    ['0.01', 1],
    ['19.99', 1999],
  ])('%s → %d cents', (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });
  it.each(['', 'abc', '-5', '1.234', '1e3', '12.', null, undefined])('rejects %s', (input) => {
    expect(parseMoney(input)).toBeNull();
  });
  it('formats cents for an input and for display', () => {
    expect(moneyInput(8550)).toBe('85.50');
    expect(moneyInput(null)).toBe('0.00');
    expect(formatMoney(8550, 'EUR', 'en')).toBe('€85.50');
    expect(formatMoney(8550, 'EUR', 'pt')).toMatch(/85,50/);
  });
});

describe('amountDueOnline', () => {
  it('charges nothing when online payment is off or the total is zero', () => {
    expect(amountDueOnline(10000, 'none', 30)).toBe(0);
    expect(amountDueOnline(10000, undefined, 30)).toBe(0);
    expect(amountDueOnline(0, 'full', 30)).toBe(0);
    expect(amountDueOnline(0, 'deposit', 30)).toBe(0);
  });
  it('charges everything in full mode', () => {
    expect(amountDueOnline(12345, 'full', 30)).toBe(12345);
  });
  it('charges the percentage in deposit mode, rounded up to a cent, never above the total', () => {
    expect(amountDueOnline(10000, 'deposit', 30)).toBe(3000);
    expect(amountDueOnline(9999, 'deposit', 30)).toBe(3000); // 2999.7 → 3000
    expect(amountDueOnline(1, 'deposit', 30)).toBe(1);
    expect(amountDueOnline(10000, 'deposit', 100)).toBe(10000);
    expect(amountDueOnline(10000, 'deposit', 250)).toBe(10000);
    expect(amountDueOnline(10000, 'deposit', undefined)).toBe(3000);
  });
});

describe('paymentTerms', () => {
  const setup = (mode: 'deposit' | 'full'): PaymentSetup => ({
    mode,
    depositPercent: 25,
    account: { restaurant_id: 'r', stripe_account_id: 'acct_1', charges_enabled: true, details_submitted: true },
  });
  it('no setup (payment off, Stripe missing or not ready) means confirm at once, unpaid', () => {
    expect(paymentTerms(20000, null)).toEqual({ amountDueCents: 0, holdMinutes: 0 });
  });
  it('with a setup the booking becomes a hold for the amount due', () => {
    expect(paymentTerms(20000, setup('deposit'))).toEqual({ amountDueCents: 5000, holdMinutes: PAYMENT_HOLD_MINUTES });
    expect(paymentTerms(20000, setup('full'))).toEqual({ amountDueCents: 20000, holdMinutes: PAYMENT_HOLD_MINUTES });
  });
  it('a free booking is never held for payment', () => {
    expect(paymentTerms(0, setup('full'))).toEqual({ amountDueCents: 0, holdMinutes: 0 });
  });
  it('the hold outlives Stripe’s 30-minute minimum session', () => {
    expect(PAYMENT_HOLD_MINUTES).toBeGreaterThan(30);
  });
});

describe('Stripe key: test mode only', () => {
  it('accepts a test key', () => {
    expect(stripeKey({ STRIPE_SECRET_KEY: 'sk_test_abc' })).toBe('sk_test_abc');
    expect(paymentsConfigured({ STRIPE_SECRET_KEY: ' sk_test_abc ' })).toBe(true);
  });
  it('ignores a live key, a restricted live key, and no key', () => {
    expect(stripeKey({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toBeNull();
    expect(stripeKey({ STRIPE_SECRET_KEY: 'rk_live_abc' })).toBeNull();
    expect(paymentsConfigured({})).toBe(false);
  });
});

describe('encodeParams', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    const encoded = encodeParams({
      mode: 'payment',
      metadata: { kind: 'stay', id: 'r 1' },
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 3000 } }],
      skip_me: undefined,
      nothing: null,
    });
    expect(decodeURIComponent(encoded).split('&')).toEqual([
      'mode=payment',
      'metadata[kind]=stay',
      'metadata[id]=r 1',
      'line_items[0][quantity]=1',
      'line_items[0][price_data][currency]=eur',
      'line_items[0][price_data][unit_amount]=3000',
    ]);
    expect(encoded).toContain('metadata%5Bid%5D=r%201');
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_900_000_000;
  const sign = (body: string, t: number, key = secret) =>
    createHmac('sha256', key).update(`${t}.${body}`).digest('hex');

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyWebhookSignature(payload, `t=${now},v1=${sign(payload, now)}`, secret, 300, now)).toBe(true);
  });
  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${sign(payload, now)}`;
    expect(verifyWebhookSignature(payload, header, secret, 300, now)).toBe(true);
  });
  it.each([
    ['a tampered body', (h: string) => [payload.replace('evt_1', 'evt_2'), h] as const],
    ['a signature made with another secret', () => [payload, `t=${now},v1=${sign(payload, now, 'whsec_other')}`] as const],
    ['a replayed, stale timestamp', () => [payload, `t=${now - 301},v1=${sign(payload, now - 301)}`] as const],
    ['a missing timestamp', () => [payload, `v1=${sign(payload, now)}`] as const],
    ['a non-hex signature', () => [payload, `t=${now},v1=not-hex`] as const],
    ['an empty header', () => [payload, ''] as const],
  ])('rejects %s', (_label, make) => {
    const [body, header] = make(`t=${now},v1=${sign(payload, now)}`);
    expect(verifyWebhookSignature(body, header, secret, 300, now)).toBe(false);
  });
  it('rejects everything when no secret is configured', () => {
    expect(verifyWebhookSignature(payload, `t=${now},v1=${sign(payload, now)}`, undefined, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, null, secret, 300, now)).toBe(false);
  });
});
