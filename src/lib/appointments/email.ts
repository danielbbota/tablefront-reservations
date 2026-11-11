import 'server-only';
import { normalizeSlot } from '../availability';
import { appUrl, send } from '../email';
import { asLang, getT, LOCALE } from '../i18n';
import { formatMoney } from '../money';
import type { Appointment, Lang, Restaurant } from '../types';

/**
 * Emails for the appointments product. Plain text like the restaurant ones:
 * guest emails follow the language the guest booked in and carry the cancel
 * link; owner emails follow the business's language. Every sender swallows
 * its own errors (see send()), so an email can never fail a booking.
 */

function formatWhen(lang: Lang, appt: Appointment): string {
  const t = getT(lang);
  const [y, m, d] = appt.date.split('-').map(Number);
  const dateStr = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${dateStr} ${t('email.at')} ${normalizeSlot(appt.start_time)}`;
}

function summary(lang: Lang, appt: Appointment, staffName?: string | null): string {
  const t = getT(lang);
  const money = (cents: number) => formatMoney(cents, appt.currency || 'EUR', lang);
  const paid = appt.paid_cents > 0;
  return [
    `${t('email.when')}: ${formatWhen(lang, appt)}`,
    `${t('appt.email.service')}: ${appt.service_name} (${t('appt.minutes', {
      n: String(appt.duration_minutes),
    })})`,
    staffName ? `${t('appt.email.with')}: ${staffName}` : null,
    appt.price_cents > 0 ? `${t('common.price')}: ${money(appt.price_cents)}` : null,
    paid ? `${t('pay.paidOnline')}: ${money(appt.paid_cents)}` : null,
    paid && appt.price_cents > appt.paid_cents
      ? `${t('pay.dueOnSite')}: ${money(appt.price_cents - appt.paid_cents)}`
      : null,
    `${t('email.name')}: ${appt.guest_name}`,
    appt.guest_phone ? `${t('email.phone')}: ${appt.guest_phone}` : null,
    appt.notes ? `${t('email.notes')}: ${appt.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function cancelLine(lang: Lang, appt: Appointment): string {
  return `${getT(lang)('email.cancelLine')}\n${appUrl()}/cancel/${appt.cancel_token}`;
}

export async function sendAppointmentConfirmation(
  business: Restaurant,
  appt: Appointment,
  staffName?: string | null
) {
  const lang = asLang(appt.guest_lang);
  const t = getT(lang);
  await send(
    appt.guest_email,
    `${t('appt.email.confirm.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${appt.guest_name},\n\n${t('appt.email.confirm.body', {
      business: business.name,
    })}\n\n${summary(lang, appt, staffName)}\n\n${cancelLine(lang, appt)}\n\n${t(
      'email.confirm.bye'
    )}\n${business.name}`
  );
}

export async function sendAppointmentReminder(
  business: Restaurant,
  appt: Appointment,
  staffName?: string | null
) {
  const lang = asLang(appt.guest_lang);
  const t = getT(lang);
  await send(
    appt.guest_email,
    `${t('appt.email.reminder.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${appt.guest_name},\n\n${t('appt.email.reminder.body', {
      business: business.name,
    })}\n\n${summary(lang, appt, staffName)}\n\n${cancelLine(lang, appt)}\n\n${t(
      'email.confirm.bye'
    )}\n${business.name}`
  );
}

export async function sendAppointmentCancellation(
  business: Restaurant,
  appt: Appointment,
  staffName?: string | null
) {
  const lang = asLang(appt.guest_lang);
  const t = getT(lang);
  const refund =
    appt.paid_cents > 0 ? `\n\n${t('cancel.refundNote', { business: business.name })}` : '';
  await send(
    appt.guest_email,
    `${t('appt.email.cancel.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${appt.guest_name},\n\n${t('appt.email.cancel.body', {
      business: business.name,
    })}\n\n${summary(lang, appt, staffName)}${refund}\n\n${t('appt.email.cancel.unexpected', {
      business: business.name,
    })}\n\n${business.name}`
  );
}

/** Owner notifications follow the business's language. */
export async function sendAppointmentOwnerNotification(
  business: Restaurant,
  appt: Appointment,
  ownerEmail: string,
  staffName?: string | null
) {
  const lang = asLang(business.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('appt.email.owner.subject')} — ${appt.guest_name}, ${formatWhen(lang, appt)}`,
    `${t('appt.email.owner.body', { business: business.name })}\n\n${summary(
      lang,
      appt,
      staffName
    )}\n${t('form.email')}: ${appt.guest_email}\n\n${t('email.owner.manage')}`
  );
}

export async function sendAppointmentOwnerCancelNotice(
  business: Restaurant,
  appt: Appointment,
  ownerEmail: string,
  staffName?: string | null
) {
  const lang = asLang(business.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('appt.email.ownerCancel.subject')} — ${appt.guest_name}, ${formatWhen(lang, appt)}`,
    `${t('appt.email.ownerCancel.body', { business: business.name })}\n\n${summary(
      lang,
      appt,
      staffName
    )}\n${t('form.email')}: ${appt.guest_email}\n\n${t('email.owner.manage')}`
  );
}
