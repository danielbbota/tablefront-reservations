// The appointment emails: who gets what, in which language, with which lines.
// The `resend` package is mocked, so nothing is ever sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appointment, Restaurant } from '@/lib/types';

type SendArgs = { from: string; to: string; subject: string; text: string };
const emailsSend = vi.fn<(args: SendArgs) => Promise<{ data: unknown; error: null }>>(async () => ({
  data: { id: 'email_1' },
  error: null,
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: emailsSend };
  },
}));

const {
  sendAppointmentCancellation,
  sendAppointmentConfirmation,
  sendAppointmentOwnerCancelNotice,
  sendAppointmentOwnerNotification,
  sendAppointmentReminder,
} = await import('@/lib/appointments/email');

const business = {
  id: 'b1',
  name: 'Barbearia Central',
  language: 'pt',
  timezone: 'Europe/Lisbon',
  currency: 'EUR',
} as Restaurant;

const appt = (partial: Partial<Appointment> = {}): Appointment =>
  ({
    id: 'a1',
    restaurant_id: 'b1',
    service_id: 's1',
    staff_id: 'st1',
    date: '2026-10-26',
    start_time: '10:00:00',
    end_time: '10:30:00',
    busy_until: '10:30:00',
    service_name: 'Corte',
    duration_minutes: 30,
    price_cents: 1500,
    guest_name: 'Ada Lovelace',
    guest_phone: '+351 910 000 000',
    guest_email: 'ada@example.test',
    notes: 'Fade',
    status: 'confirmed',
    source: 'widget',
    service_status: null,
    amount_due_cents: 0,
    paid_cents: 0,
    currency: 'EUR',
    payment_status: 'none',
    stripe_session_id: null,
    hold_expires_at: null,
    guest_lang: 'en',
    cancel_token: 'tok-123',
    reminder_sent_at: null,
    created_at: '2026-10-21T10:00:00Z',
    ...partial,
  }) as Appointment;

const sent = () => emailsSend.mock.calls[0][0];

beforeEach(() => {
  emailsSend.mockClear();
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3100';
});

describe('guest emails', () => {
  it('confirmation: guest language, every detail, and the cancel link', async () => {
    await sendAppointmentConfirmation(business, appt(), 'Rui');
    expect(emailsSend).toHaveBeenCalledTimes(1);
    const mail = sent();
    expect(mail.to).toBe('ada@example.test');
    expect(mail.subject).toBe('Appointment confirmed — Barbearia Central');
    expect(mail.text).toContain('Hi Ada Lovelace,');
    expect(mail.text).toContain('Your appointment at Barbearia Central is confirmed.');
    // ICU versions differ on the comma after the weekday.
    expect(mail.text).toMatch(/When: Monday,? 26 October 2026 at 10:00/);
    expect(mail.text).toContain('Service: Corte (30 min)');
    expect(mail.text).toContain('With: Rui');
    expect(mail.text).toContain('Price: €15.00');
    expect(mail.text).toContain('Phone: +351 910 000 000');
    expect(mail.text).toContain('Notes: Fade');
    expect(mail.text).toContain('http://localhost:3100/cancel/tok-123');
    expect(mail.text).not.toContain('Paid online');
  });

  it('follows the language the guest booked in, not the business language', async () => {
    await sendAppointmentConfirmation(business, appt({ guest_lang: 'de' }), 'Rui');
    expect(sent().subject).toBe('Termin bestätigt — Barbearia Central');
    expect(sent().text).toContain('Leistung: Corte (30 Min.)');
    expect(sent().text).toContain('Bei: Rui');
  });

  it('shows what was paid online and what is left to pay on site', async () => {
    await sendAppointmentConfirmation(business, appt({ paid_cents: 450, payment_status: 'paid' }));
    const text = sent().text;
    expect(text).toContain('Paid online: €4.50');
    expect(text).toContain('To pay on site: €10.50');
    expect(text).not.toContain('With:');
  });

  it('a fully paid appointment has nothing left to pay on site', async () => {
    await sendAppointmentConfirmation(business, appt({ paid_cents: 1500, payment_status: 'paid' }));
    expect(sent().text).toContain('Paid online: €15.00');
    expect(sent().text).not.toContain('To pay on site');
  });

  it('a free service shows no price line', async () => {
    await sendAppointmentConfirmation(business, appt({ price_cents: 0 }));
    expect(sent().text).not.toContain('Price:');
  });

  it('reminder carries the cancel link too', async () => {
    await sendAppointmentReminder(business, appt({ guest_lang: 'fr' }), 'Rui');
    expect(sent().subject).toBe('Rappel — votre rendez-vous demain — Barbearia Central');
    expect(sent().text).toContain('http://localhost:3100/cancel/tok-123');
  });

  it('cancellation has no cancel link, and mentions the refund only when something was paid', async () => {
    await sendAppointmentCancellation(business, appt({ guest_lang: 'pt' }), 'Rui');
    expect(sent().subject).toBe('Marcação cancelada — Barbearia Central');
    expect(sent().text).toContain('A sua marcação em Barbearia Central foi cancelada.');
    expect(sent().text).not.toContain('/cancel/');
    expect(sent().text).not.toContain('reembolso');

    emailsSend.mockClear();
    await sendAppointmentCancellation(business, appt({ guest_lang: 'pt', paid_cents: 450 }), 'Rui');
    expect(sent().text).toContain('Se pagou online, Barbearia Central trata de qualquer reembolso');
  });

  it('sends nothing when the guest has no email (manual bookings)', async () => {
    await sendAppointmentConfirmation(business, appt({ guest_email: '' }));
    expect(emailsSend).not.toHaveBeenCalled();
  });
});

describe('owner emails', () => {
  it('new appointment: business language, guest email included, no cancel link', async () => {
    await sendAppointmentOwnerNotification(business, appt(), 'owner@example.test', 'Rui');
    const mail = sent();
    expect(mail.to).toBe('owner@example.test');
    expect(mail.subject).toMatch(/^Nova marcação — Ada Lovelace, segunda-feira,? 26 de outubro de 2026 às 10:00$/);
    expect(mail.text).toContain('Nova marcação online para Barbearia Central:');
    expect(mail.text).toContain('Serviço: Corte (30 min)');
    expect(mail.text).toContain('Com: Rui');
    expect(mail.text).toContain('Email: ada@example.test');
    expect(mail.text).not.toContain('/cancel/');
  });

  it('cancelled by the client', async () => {
    await sendAppointmentOwnerCancelNotice(business, appt(), 'owner@example.test', 'Rui');
    expect(sent().to).toBe('owner@example.test');
    expect(sent().subject).toMatch(/^Marcação cancelada pelo cliente — Ada Lovelace/);
    expect(sent().text).toContain('Um cliente cancelou a sua marcação em Barbearia Central:');
  });
});

describe('failures never escape', () => {
  it('a rejected send is swallowed', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    emailsSend.mockRejectedValueOnce(new Error('resend down'));
    await expect(sendAppointmentConfirmation(business, appt())).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});
