import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { confirmPaid, releaseHold, type PayableKind } from '@/lib/payments/checkout';
import { notifyConfirmed } from '@/lib/payments/notify';
import { verifyWebhookSignature, type CheckoutSession } from '@/lib/payments/stripe';
import type { Appointment, StayReservation } from '@/lib/types';

type StripeEvent = {
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

const isKind = (v: unknown): v is PayableKind => v === 'stay' || v === 'appointment';

/**
 * POST /api/stripe/webhook — Stripe Connect webhook (events from the
 * businesses' connected accounts). Configure it in the Stripe dashboard for:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.expired, account.updated
 *
 * The signature is verified against the raw body; anything unsigned is
 * refused. Handlers are idempotent, so Stripe's retries are harmless.
 */
export async function POST(req: NextRequest) {
  const payload = await req.text();
  const valid = verifyWebhookSignature(
    payload,
    req.headers.get('stripe-signature'),
    process.env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // Project rule: Stripe runs in test mode only. Acknowledge and ignore live events.
  if (event.livemode) return NextResponse.json({ received: true, ignored: 'livemode' });

  const supabase = createAdminClient();
  const object = event.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = object as unknown as CheckoutSession;
      const kind = session.metadata?.kind;
      if (!isKind(kind)) break;
      const row = await confirmPaid<StayReservation | Appointment>(supabase, kind, session);
      if (row) await notifyConfirmed(supabase, kind, row);
      break;
    }
    case 'checkout.session.expired': {
      const session = object as unknown as CheckoutSession;
      const kind = session.metadata?.kind;
      if (isKind(kind)) await releaseHold(supabase, kind, session.id);
      break;
    }
    case 'account.updated': {
      const accountId = String(object.id ?? '');
      if (accountId) {
        await supabase
          .from('payment_accounts')
          .update({
            charges_enabled: object.charges_enabled === true,
            details_submitted: object.details_submitted === true,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_account_id', accountId);
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
