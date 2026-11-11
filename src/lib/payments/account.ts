import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentAccount } from '../types';
import { retrieveAccount } from './stripe';

/**
 * Re-read the business's connected account from Stripe and store whether it
 * can take charges yet. Called when the owner comes back from Stripe's
 * onboarding; the `account.updated` webhook keeps it current afterwards.
 * Needs the service-role client: owners can only read payment_accounts.
 */
export async function refreshPaymentAccount(
  supabase: SupabaseClient,
  businessId: string
): Promise<PaymentAccount | null> {
  const { data: account } = await supabase
    .from('payment_accounts')
    .select('*')
    .eq('restaurant_id', businessId)
    .maybeSingle<PaymentAccount>();
  if (!account) return null;

  try {
    const remote = await retrieveAccount(account.stripe_account_id);
    const { data: updated } = await supabase
      .from('payment_accounts')
      .update({
        charges_enabled: remote.charges_enabled,
        details_submitted: remote.details_submitted,
        updated_at: new Date().toISOString(),
      })
      .eq('restaurant_id', businessId)
      .select()
      .maybeSingle<PaymentAccount>();
    return updated ?? account;
  } catch (err) {
    console.error('[payments] could not refresh account', account.stripe_account_id, err);
    return account;
  }
}
