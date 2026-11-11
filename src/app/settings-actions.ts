'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { asLang, getT, type TKey } from '@/lib/i18n';
import type { OperatingHours, Restaurant } from '@/lib/types';

/**
 * Settings for an appointments business: language, timezone, currency, the
 * booking grid and the opening hours professionals follow by default.
 * (Restaurants use saveSettings in actions.ts, stays saveStaysSettings.)
 */

function fail(message: string): never {
  redirect(`/settings?error=${encodeURIComponent(message)}`);
}

export async function saveAppointmentsSettings(formData: FormData) {
  const supabase = await createServerSupabase();
  const { data: business } = await supabase.from('restaurants').select('*').single<Restaurant>();
  if (!business) redirect('/login');
  const t = getT(asLang(business.language));

  const language = String(formData.get('language') ?? 'en');
  if (!['en', 'pt', 'de', 'fr'].includes(language)) fail('Invalid language.');

  const timezone = String(formData.get('timezone') ?? '').trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      fail(`Invalid timezone: ${timezone}`);
    }
  }

  const currency = String(formData.get('currency') ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(t('vset.err.currency'));

  const slotInterval = Number(formData.get('slotInterval'));
  if (!Number.isInteger(slotInterval) || slotInterval < 15 || slotInterval > 120)
    fail(t('vset.err.slotInterval'));

  const hours: OperatingHours = {};
  const TIME_RE = /^\d{2}:\d{2}$/;
  for (let d = 0; d < 7; d++) {
    const open = String(formData.get(`open_${d}`) ?? '09:00');
    const close = String(formData.get(`close_${d}`) ?? '19:00');
    const closed = formData.get(`closed_${d}`) === 'on';
    if (!closed && (!TIME_RE.test(open) || !TIME_RE.test(close) || open >= close))
      fail(t('vset.err.hours', { day: t(`days.${d}` as TKey) }));
    hours[String(d)] = { open, close, closed };
  }

  const { error } = await supabase
    .from('restaurants')
    .update({
      language,
      currency,
      slot_interval_minutes: slotInterval,
      operating_hours: hours,
      ...(timezone ? { timezone } : {}),
    })
    .eq('id', business.id);
  if (error) fail(error.message);

  revalidatePath('/settings');
  redirect('/settings?saved=1');
}
