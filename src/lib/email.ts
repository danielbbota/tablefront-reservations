import 'server-only';
import { Resend } from 'resend';
import type { Booking, Lang, Restaurant } from './types';
import { normalizeSlot } from './availability';
import { getT, LOCALE, asLang } from './i18n';

const from = () => process.env.EMAIL_FROM || 'TableFront <onboarding@resend.dev>';
const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || 'https://app.tablesfront.com';

function resend() {
  return new Resend(process.env.RESEND_API_KEY);
}

/** Guest-facing emails follow the language the guest booked in. */
function guestLang(booking: Booking): Lang {
  return asLang(booking.guest_lang);
}

function formatWhen(lang: Lang, booking: Booking): string {
  const t = getT(lang);
  const [y, m, d] = booking.date.split('-').map(Number);
  const dateStr = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${dateStr} ${t('email.at')} ${normalizeSlot(booking.time_slot)}`;
}

function bookingSummary(lang: Lang, booking: Booking): string {
  const t = getT(lang);
  return [
    `${t('email.when')}: ${formatWhen(lang, booking)}`,
    `${t('email.party')}: ${booking.party_size}`,
    `${t('email.name')}: ${booking.guest_name}`,
    `${t('email.phone')}: ${booking.guest_phone}`,
    booking.notes ? `${t('email.notes')}: ${booking.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function cancelLine(lang: Lang, booking: Booking): string {
  const t = getT(lang);
  return `${t('email.cancelLine')}\n${appUrl()}/cancel/${booking.cancel_token}`;
}

/**
 * All senders swallow their own errors: a failed email must never fail the
 * booking itself. Callers still await them (serverless kills stray promises).
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
  const lang = guestLang(booking);
  const t = getT(lang);
  await send(
    booking.guest_email,
    `${t('email.confirm.subject')} — ${restaurant.name}`,
    `${t('email.confirm.hi')} ${booking.guest_name},\n\n${t('email.confirm.body', {
      restaurant: restaurant.name,
    })}\n\n${bookingSummary(lang, booking)}\n\n${cancelLine(lang, booking)}\n\n${t(
      'email.confirm.bye'
    )}\n${restaurant.name}`
  );
}

export async function sendGuestReminder(restaurant: Restaurant, booking: Booking) {
  const lang = guestLang(booking);
  const t = getT(lang);
  await send(
    booking.guest_email,
    `${t('email.reminder.subject')} — ${restaurant.name}`,
    `${t('email.confirm.hi')} ${booking.guest_name},\n\n${t('email.reminder.body', {
      restaurant: restaurant.name,
    })}\n\n${bookingSummary(lang, booking)}\n\n${cancelLine(lang, booking)}\n\n${t(
      'email.confirm.bye'
    )}\n${restaurant.name}`
  );
}

export async function sendGuestCancellation(restaurant: Restaurant, booking: Booking) {
  const lang = guestLang(booking);
  const t = getT(lang);
  await send(
    booking.guest_email,
    `${t('email.cancel.subject')} — ${restaurant.name}`,
    `${t('email.confirm.hi')} ${booking.guest_name},\n\n${t('email.cancel.body', {
      restaurant: restaurant.name,
    })}\n\n${bookingSummary(lang, booking)}\n\n${t('email.cancel.unexpected')}\n\n${
      restaurant.name
    }`
  );
}

/** Owner notifications follow the restaurant's language. */
export async function sendOwnerNotification(
  restaurant: Restaurant,
  booking: Booking,
  ownerEmail: string
) {
  const lang = asLang(restaurant.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('email.owner.subject')} — ${booking.guest_name}, ${formatWhen(lang, booking)}`,
    `${t('email.owner.body', { restaurant: restaurant.name })}\n\n${bookingSummary(
      lang,
      booking
    )}\n${t('form.email')}: ${booking.guest_email}\n\n${t('email.owner.manage')}`
  );
}

export async function sendOwnerCancelNotice(
  restaurant: Restaurant,
  booking: Booking,
  ownerEmail: string
) {
  const lang = asLang(restaurant.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('email.ownerCancel.subject')} — ${booking.guest_name}, ${formatWhen(lang, booking)}`,
    `${t('email.ownerCancel.body', { restaurant: restaurant.name })}\n\n${bookingSummary(
      lang,
      booking
    )}\n${t('form.email')}: ${booking.guest_email}\n\n${t('email.owner.manage')}`
  );
}
