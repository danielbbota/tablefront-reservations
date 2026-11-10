import type { Lang } from './types';
import { LOCALE } from './i18n';

/** "85", "85.5", "85,50" → cents. Null when it is not a non-negative amount. */
export function parseMoney(input: unknown): number | null {
  const raw = String(input ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

/** Cents → "85.00" for an <input type="number" step="0.01">. */
export function moneyInput(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

export function formatMoney(cents: number, currency: string, lang: Lang): string {
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * What the guest pays online at booking time. 'deposit' rounds up to a whole
 * cent and never exceeds the total; a zero total never asks for payment.
 */
export function amountDueOnline(
  totalCents: number,
  mode: 'none' | 'deposit' | 'full' | undefined,
  depositPercent: number | undefined
): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  if (mode === 'full') return totalCents;
  if (mode === 'deposit') {
    const pct = Math.min(100, Math.max(1, Math.round(depositPercent ?? 30)));
    return Math.min(totalCents, Math.ceil((totalCents * pct) / 100));
  }
  return 0;
}
