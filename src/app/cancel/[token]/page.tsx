import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeSlot, nowInTimezone } from '@/lib/availability';
import { asLang, getT } from '@/lib/i18n';
import { sendGuestCancellation, sendOwnerCancelNotice } from '@/lib/email';
import type { Booking, Restaurant } from '@/lib/types';

/**
 * Public, tokenized guest cancellation page — no login. The unguessable
 * cancel_token (from the confirmation/reminder email) is the credential.
 * Rendered in the language the guest booked in.
 */
export default async function CancelPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;

  const supabase = createAdminClient();
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('cancel_token', token)
    .maybeSingle<Booking>();

  const card = (children: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="tf-rise w-full max-w-md rounded-2xl border border-linen bg-white p-8 shadow-lift">
        {children}
      </div>
    </main>
  );

  if (!booking) {
    return card(<p className="text-sm text-espresso">{getT('en')('cancel.notFound')}</p>);
  }

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', booking.restaurant_id)
    .single<Restaurant>();
  if (!restaurant) {
    return card(<p className="text-sm text-espresso">{getT('en')('cancel.notFound')}</p>);
  }

  const t = getT(asLang(booking.guest_lang));
  const summary = (
    <div className="mt-4 space-y-1 rounded-lg bg-sand/60 p-4 text-sm text-espresso">
      <p className="font-serif text-base font-semibold">{restaurant.name}</p>
      <p>
        {booking.date} · {normalizeSlot(booking.time_slot)} · {booking.party_size}
      </p>
      <p className="text-espresso/60">{booking.guest_name}</p>
    </div>
  );

  if (done || booking.status === 'cancelled') {
    return card(
      <>
        <h1 className="font-serif text-xl font-semibold text-espresso">{t('cancel.title')}</h1>
        <p className="mt-3 rounded-lg bg-leaf/10 px-4 py-3 text-sm text-leaf">
          {done ? t('cancel.done') : t('cancel.already')}
        </p>
        {summary}
      </>
    );
  }

  const today = nowInTimezone(restaurant.timezone).date;
  if (booking.date < today) {
    return card(
      <>
        <h1 className="font-serif text-xl font-semibold text-espresso">{t('cancel.title')}</h1>
        <p className="mt-3 text-sm text-espresso/70">{t('cancel.past')}</p>
        {summary}
      </>
    );
  }

  async function cancelBooking() {
    'use server';
    const supabase = createAdminClient();
    // Re-read under the token and only flip confirmed → cancelled.
    const { data: fresh } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('cancel_token', token)
      .eq('status', 'confirmed')
      .select()
      .maybeSingle<Booking>();

    if (fresh) {
      const { data: rest } = await supabase
        .from('restaurants')
        .select('*')
        .eq('id', fresh.restaurant_id)
        .single<Restaurant>();
      if (rest) {
        const { data: owner } = await supabase
          .from('owners')
          .select('email')
          .eq('restaurant_id', rest.id)
          .limit(1)
          .maybeSingle<{ email: string }>();
        await Promise.allSettled([
          sendGuestCancellation(rest, fresh),
          owner?.email ? sendOwnerCancelNotice(rest, fresh, owner.email) : Promise.resolve(),
        ]);
      }
    }
    redirect(`/cancel/${token}?done=1`);
  }

  return card(
    <>
      <h1 className="font-serif text-xl font-semibold text-espresso">{t('cancel.title')}</h1>
      <p className="mt-2 text-sm text-espresso/70">
        {t('cancel.intro', { restaurant: restaurant.name })}
      </p>
      {summary}
      <form action={cancelBooking} className="mt-5">
        <button className="min-h-11 w-full rounded-lg bg-wine px-4 py-2.5 text-sm font-semibold text-cream transition hover:opacity-90 active:scale-[0.985]">
          {t('cancel.confirm')}
        </button>
      </form>
    </>
  );
}
