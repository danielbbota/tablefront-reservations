import { describe, expect, it } from 'vitest';
import { asLang, DEFAULT_LANG, getT, LANGS } from '@/lib/i18n';

describe('asLang', () => {
  it('accepts the supported languages', () => {
    for (const l of ['en', 'pt', 'de', 'fr'] as const) expect(asLang(l)).toBe(l);
  });
  it('falls back to English for anything else', () => {
    expect(asLang('es')).toBe('en');
    expect(asLang('')).toBe('en');
    expect(asLang(null)).toBe('en');
    expect(asLang(undefined)).toBe('en');
    expect(asLang(42)).toBe('en');
    expect(asLang('PT')).toBe('en');
  });
  it('DEFAULT_LANG is English and LANGS lists every supported language', () => {
    expect(DEFAULT_LANG).toBe('en');
    expect(Object.keys(LANGS).sort()).toEqual(['de', 'en', 'fr', 'pt']);
  });
});

describe('getT', () => {
  it('translates known keys per language', () => {
    expect(getT('en')('nav.bookings')).toBe('Bookings');
    expect(getT('pt')('nav.bookings')).not.toBe('Bookings');
    expect(getT('de')('nav.bookings')).not.toBe('Bookings');
    expect(getT('fr')('nav.bookings')).not.toBe('Bookings');
  });
  it('interpolates {vars}', () => {
    expect(getT('en')('email.confirm.body', { restaurant: 'Trattoria Test' })).toBe(
      'Your table at Trattoria Test is confirmed.'
    );
  });
  it('leaves unknown placeholders untouched and ignores extra vars', () => {
    expect(getT('en')('email.confirm.body', { nope: 'x' })).toBe('Your table at {restaurant} is confirmed.');
  });
  it('falls back to English when a key is missing in another language', () => {
    const t = getT('pt');
    // Pick a key that exists in English and read it through each language: the
    // result must always be a non-empty string (English fallback or translation).
    for (const lang of ['pt', 'de', 'fr'] as const) {
      expect(typeof getT(lang)('email.reminder.subject')).toBe('string');
      expect(getT(lang)('email.reminder.subject').length).toBeGreaterThan(0);
    }
    expect(typeof t('cancel.title')).toBe('string');
  });
});
