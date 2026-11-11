'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { asLang, getT } from '@/lib/i18n';
import {
  createConnectedAccount,
  createOnboardingLink,
  paymentsConfigured,
} from '@/lib/payments/stripe';
import type { PaymentAccount, Restaurant } from '@/lib/types';

/**
 * Online payment settings for stays and appointments businesses.
 * Form-bound actions: feedback flows via redirect query params.
 */

function fail(message: string): never {
  redirect(`/settings?error=${encodeURIComponent(message)}#payments`);
}

async function context() {
  const supabase = await createServerSupabase();
  const { data: business } = await supabase.from('restaurants').select('*').single<Restaurant>();
  if (!business) redirect('/login');
  return { supabase, business, t: getT(asLang(business.language)) };
}

export async function savePaymentSettings(formData: FormData) {
  const { supabase, business, t } = await context();

  const mode = String(formData.get('paymentMode') ?? 'none');
  if (!['none', 'deposit', 'full'].includes(mode)) fail(t('pay.invalidPercent'));
  const percent = Number(formData.get('depositPercent') ?? business.deposit_percent ?? 30);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) fail(t('pay.invalidPercent'));

  const { error } = await supabase
    .from('restaurants')
    .update({ payment_mode: mode, deposit_percent: percent })
    .eq('id', business.id);
  if (error) fail(error.message);

  revalidatePath('/settings');
  redirect('/settings?paysaved=1#payments');
}

/**
 * Start (or resume) Stripe onboarding: create the business's connected
 * account on first use, then send the owner to Stripe's hosted form. They
 * come back to /settings?stripe=return, which re-reads the account status.
 */
export async function connectStripe() {
  const { supabase, business, t } = await context();
  if (!paymentsConfigured()) fail(t('pay.stripe.unavailable'));

  const admin = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.tablesfront.com';

  let url: string;
  try {
    let { data: account } = await admin
      .from('payment_accounts')
      .select('*')
      .eq('restaurant_id', business.id)
      .maybeSingle<PaymentAccount>();

    if (!account) {
      const { data: owner } = await supabase
        .from('owners')
        .select('email')
        .single<{ email: string }>();
      const created = await createConnectedAccount(owner?.email ?? '', business.name);
      const { data: inserted, error } = await admin
        .from('payment_accounts')
        .insert({ restaurant_id: business.id, stripe_account_id: created.id })
        .select()
        .single<PaymentAccount>();
      if (error || !inserted) throw new Error(error?.message ?? 'Could not store the Stripe account.');
      account = inserted;
    }

    const link = await createOnboardingLink(
      account.stripe_account_id,
      `${appUrl}/settings?stripe=return#payments`,
      `${appUrl}/settings?stripe=refresh#payments`
    );
    url = link.url;
  } catch (err) {
    fail(t('pay.stripe.error', { message: err instanceof Error ? err.message : String(err) }));
  }

  redirect(url);
}
