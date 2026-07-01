import 'server-only';
import { Resend } from 'resend';
import type { Booking, Restaurant } from './types';
import { normalizeSlot } from './availability';

const from = () => process.env.EMAIL_FROM || 'TableFront <onboarding@resend.dev>';

function resend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function formatWhen(booking: Booking): string {
  const [y, m, d] = booking.date.split('-').map(Number);
  const dateStr = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${dateStr} at ${normalizeSlot(booking.time_slot)}`;
}

function bookingSummary(booking: Booking): string {
  return [
    `When: ${formatWhen(booking)}`,
    `Party size: ${booking.party_size}`,
    `Name: ${booking.guest_name}`,
    `Phone: ${booking.guest_phone}`,
    booking.notes ? `Notes: ${booking.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * All senders are fire-and-forget: a failed email must never fail the
 * booking itself, so callers do not await rejections — we log and move on.
 */
async function send(to: string, subject: string, text: string) {
  try {
    const { error } = await resend().emails.send({ from: from(), to, subject, text });
    if (error) console.error('[email] send failed:', subject, error);
  } catch (err) {
    console.error('[email] send threw:', subject, err);
  }
}

export async function sendGuestConfirmation(restaurant: Restaurant, booking: Booking) {
  await send(
    booking.guest_email,
    `Booking confirmed — ${restaurant.name}`,
    `Hi ${booking.guest_name},\n\nYour table at ${restaurant.name} is confirmed.\n\n${bookingSummary(
      booking
    )}\n\nNeed to change or cancel? Please contact the restaurant directly.\n\nSee you soon!\n${restaurant.name}`
  );
}

export async function sendOwnerNotification(
  restaurant: Restaurant,
  booking: Booking,
  ownerEmail: string
) {
  await send(
    ownerEmail,
    `New booking — ${booking.guest_name}, ${formatWhen(booking)}`,
    `New online booking for ${restaurant.name}:\n\n${bookingSummary(
      booking
    )}\nEmail: ${booking.guest_email}\n\nManage it in your TableFront dashboard.`
  );
}

export async function sendGuestCancellation(restaurant: Restaurant, booking: Booking) {
  await send(
    booking.guest_email,
    `Booking cancelled — ${restaurant.name}`,
    `Hi ${booking.guest_name},\n\nYour booking at ${restaurant.name} has been cancelled.\n\n${bookingSummary(
      booking
    )}\n\nIf this is unexpected, please contact the restaurant directly.\n\n${restaurant.name}`
  );
}
