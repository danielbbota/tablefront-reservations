/**
 * Strings for the appointments product (clinics, barbers, salons).
 * Merged into the dictionary in i18n.ts.
 */
const en = {
  'nav.agenda': 'Calendar',
  'nav.appts.list': 'Appointments',
  'nav.appts.new': 'New appointment',
  'nav.services': 'Services',
  'nav.team': 'Team',
} as const;

type Dict = Record<keyof typeof en, string>;

const pt: Dict = {
  'nav.agenda': 'Agenda',
  'nav.appts.list': 'Marcações',
  'nav.appts.new': 'Nova marcação',
  'nav.services': 'Serviços',
  'nav.team': 'Equipa',
};

const de: Dict = {
  'nav.agenda': 'Kalender',
  'nav.appts.list': 'Termine',
  'nav.appts.new': 'Neuer Termin',
  'nav.services': 'Leistungen',
  'nav.team': 'Team',
};

const fr: Dict = {
  'nav.agenda': 'Agenda',
  'nav.appts.list': 'Rendez-vous',
  'nav.appts.new': 'Nouveau rendez-vous',
  'nav.services': 'Prestations',
  'nav.team': 'Équipe',
};

export const appointmentsDict = { en, pt, de, fr } as const;
