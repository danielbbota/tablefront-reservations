import 'server-only';
import { Resend } from 'resend';
import type { Booking, Restaurant } from './types';
import { normalizeSlot } from './availability';
import { getT, LOCALE, asLang } from './i18n';

const from = () => process.env.EMAIL_FROM || 'TableFront <onboarding@resend.dev>';

function resend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function formatWhen(restaurant: Restaurant, booking: Booking): string {
  const t = getT(asLang(restaurant.language));
  const [y, m, d] = booking.date.split('-').map(Number);
  const dateStr = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(
    LOCALE[asLang(restaurant.language)],
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
  );
  return `${dateStr} ${t('email.at')} ${normalizeSlot(booking.time_slot)}`;
}

function bookingSummary(restaurant: Restaurant, booking: Booking): string {
  const t = getT(asLang(restaurant.language));
  return [
    `${t('email.when')}: ${formatWhen(restaurant, booking)}`,
    `${t('email.party')}: ${booking.party_size}`,
    `${t('email.name')}: ${booking.guest_name}`,
    `${t('email.phone')}: ${booking.guest_phone}`,
    booking.notes ? `${t('email.notes')}: ${booking.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * All senders are fire-and-forget: a failed email must never fail the
 * booking itself, so we log errors and move on.
 */
async function send(to: string, subject: string, text: string) {
  if (!to) return;
  try {
    const { error } = await resend().emails.send({ from: from(), to, subject, text });
    if (error) console.error('[email] send failed:', subject, error);
  } catch (err) {
    console.error('[email] send threw:', subject, err);
  }
}

export async function sendGuestConfirmation(restaurant: Restaurant, booking: Booking) {
  const t = getT(asLang(restaurant.language));
  await send(
    booking.guest_email,
    `${t('email.confirm.subject')} — ${restaurant.name}`,
    `${t('email.confirm.hi')} ${booking.guest_name},\n\n${t('email.confirm.body', {
      restaurant: restaurant.name,
    })}\n\n${bookingSummary(restaurant, booking)}\n\n${t('email.confirm.change')}\n\n${t(
      'email.confirm.bye'
    )}\n${restaurant.name}`
  );
}

export async function sendOwnerNotification(
  restaurant: Restaurant,
  booking: Booking,
  ownerEmail: string
) {
  const t = getT(asLang(restaurant.language));
  await send(
    ownerEmail,
    `${t('email.owner.subject')} — ${booking.guest_name}, ${formatWhen(restaurant, booking)}`,
    `${t('email.owner.body', { restaurant: restaurant.name })}\n\n${bookingSummary(
      restaurant,
      booking
    )}\n${t('form.email')}: ${booking.guest_email}\n\n${t('email.owner.manage')}`
  );
}

export async function sendGuestCancellation(restaurant: Restaurant, booking: Booking) {
  const t = getT(asLang(restaurant.language));
  await send(
    booking.guest_email,
    `${t('email.cancel.subject')} — ${restaurant.name}`,
    `${t('email.confirm.hi')} ${booking.guest_name},\n\n${t('email.cancel.body', {
      restaurant: restaurant.name,
    })}\n\n${bookingSummary(restaurant, booking)}\n\n${t('email.cancel.unexpected')}\n\n${
      restaurant.name
    }`
  );
}
