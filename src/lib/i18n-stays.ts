/**
 * Strings for the stays product (hotels, guesthouses, holiday rentals).
 * Merged into the dictionary in i18n.ts.
 */
const en = {
  'nav.stays.calendar': 'Calendar',
  'nav.stays.reservations': 'Reservations',
  'nav.stays.new': 'New reservation',
  'nav.stays.units': 'Units',
} as const;

type Dict = Record<keyof typeof en, string>;

const pt: Dict = {
  'nav.stays.calendar': 'Calendário',
  'nav.stays.reservations': 'Reservas',
  'nav.stays.new': 'Nova reserva',
  'nav.stays.units': 'Alojamentos',
};

const de: Dict = {
  'nav.stays.calendar': 'Kalender',
  'nav.stays.reservations': 'Reservierungen',
  'nav.stays.new': 'Neue Reservierung',
  'nav.stays.units': 'Unterkünfte',
};

const fr: Dict = {
  'nav.stays.calendar': 'Calendrier',
  'nav.stays.reservations': 'Réservations',
  'nav.stays.new': 'Nouvelle réservation',
  'nav.stays.units': 'Logements',
};

export const staysDict = { en, pt, de, fr } as const;
