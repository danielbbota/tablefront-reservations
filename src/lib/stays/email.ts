import 'server-only';
import { appUrl, send } from '../email';
import { asLang, getT, LOCALE } from '../i18n';
import { formatMoney } from '../money';
import type { Lang, Restaurant, StayReservation, StayUnit } from '../types';
import { daysBetween } from './dates';

/**
 * Emails for the stays product. Same rules as lib/email.ts: plain text, guest
 * emails in the language the guest booked in, owner emails in the business's
 * language, and a failed send never fails the reservation.
 */

type UnitName = Pick<StayUnit, 'name'> | null | undefined;

function longDate(lang: Lang, date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const hhmm = (time: string | undefined, fallback: string) => (time ?? fallback).slice(0, 5);

function summary(lang: Lang, business: Restaurant, unit: UnitName, res: StayReservation): string {
  const t = getT(lang);
  const money = (cents: number) => formatMoney(cents, res.currency, lang);
  const lines = [
    unit?.name ? `${t('semail.unit')}: ${unit.name}` : null,
    `${t('semail.checkIn')}: ${longDate(lang, res.check_in)} (${t('semail.from', {
      time: hhmm(business.check_in_time, '15:00'),
    })})`,
    `${t('semail.checkOut')}: ${longDate(lang, res.check_out)} (${t('semail.until', {
      time: hhmm(business.check_out_time, '11:00'),
    })})`,
    `${t('semail.nights')}: ${daysBetween(res.check_in, res.check_out)}`,
    `${t('semail.guests')}: ${res.guests}`,
    `${t('email.name')}: ${res.guest_name}`,
    res.guest_phone ? `${t('email.phone')}: ${res.guest_phone}` : null,
    res.total_cents > 0 ? `${t('common.total')}: ${money(res.total_cents)}` : null,
    res.paid_cents > 0 ? `${t('pay.paidOnline')}: ${money(res.paid_cents)}` : null,
    res.paid_cents > 0 && res.total_cents > res.paid_cents
      ? `${t('pay.dueOnSite')}: ${money(res.total_cents - res.paid_cents)}`
      : null,
    res.notes ? `${t('email.notes')}: ${res.notes}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function cancelLine(lang: Lang, res: StayReservation): string {
  return `${getT(lang)('email.cancelLine')}\n${appUrl()}/cancel/${res.cancel_token}`;
}

export async function sendStayConfirmation(business: Restaurant, unit: UnitName, res: StayReservation) {
  const lang = asLang(res.guest_lang);
  const t = getT(lang);
  await send(
    res.guest_email,
    `${t('semail.confirm.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${res.guest_name},\n\n${t('semail.confirm.body', {
      business: business.name,
    })}\n\n${summary(lang, business, unit, res)}\n\n${cancelLine(lang, res)}\n\n${t(
      'email.confirm.bye'
    )}\n${business.name}`
  );
}

export async function sendStayReminder(business: Restaurant, unit: UnitName, res: StayReservation) {
  const lang = asLang(res.guest_lang);
  const t = getT(lang);
  await send(
    res.guest_email,
    `${t('semail.reminder.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${res.guest_name},\n\n${t('semail.reminder.body', {
      business: business.name,
    })}\n\n${summary(lang, business, unit, res)}\n\n${cancelLine(lang, res)}\n\n${t(
      'email.confirm.bye'
    )}\n${business.name}`
  );
}

export async function sendStayCancellation(business: Restaurant, unit: UnitName, res: StayReservation) {
  const lang = asLang(res.guest_lang);
  const t = getT(lang);
  const refund = res.paid_cents > 0 ? `\n\n${t('cancel.refundNote', { business: business.name })}` : '';
  await send(
    res.guest_email,
    `${t('semail.cancel.subject')} — ${business.name}`,
    `${t('email.confirm.hi')} ${res.guest_name},\n\n${t('semail.cancel.body', {
      business: business.name,
    })}\n\n${summary(lang, business, unit, res)}${refund}\n\n${t('semail.cancel.unexpected')}\n\n${
      business.name
    }`
  );
}

export async function sendStayOwnerNotification(
  business: Restaurant,
  unit: UnitName,
  res: StayReservation,
  ownerEmail: string
) {
  const lang = asLang(business.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('semail.owner.subject')} — ${res.guest_name}, ${res.check_in} → ${res.check_out}`,
    `${t('semail.owner.body', { business: business.name })}\n\n${summary(
      lang,
      business,
      unit,
      res
    )}\n${t('form.email')}: ${res.guest_email}\n\n${t('email.owner.manage')}`
  );
}

export async function sendStayOwnerCancelNotice(
  business: Restaurant,
  unit: UnitName,
  res: StayReservation,
  ownerEmail: string
) {
  const lang = asLang(business.language);
  const t = getT(lang);
  await send(
    ownerEmail,
    `${t('semail.ownerCancel.subject')} — ${res.guest_name}, ${res.check_in} → ${res.check_out}`,
    `${t('semail.ownerCancel.body', { business: business.name })}\n\n${summary(
      lang,
      business,
      unit,
      res
    )}\n${t('form.email')}: ${res.guest_email}\n\n${t('email.owner.manage')}`
  );
}
