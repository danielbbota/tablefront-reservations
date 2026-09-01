export type DayHours = {
  open: string; // "18:00"
  close: string; // "22:00"
  closed: boolean;
};

/** Keyed by day of week: "0" = Sunday … "6" = Saturday */
export type OperatingHours = Record<string, DayHours>;

export type Lang = 'en' | 'pt' | 'de' | 'fr';

export type Restaurant = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  slot_interval_minutes: number;
  operating_hours: OperatingHours;
  default_max_covers: number;
  language: Lang;
  turn_time_minutes: number;
  brand: Record<string, string>;
  created_at: string;
};

export type FloorZone = {
  id: string;
  restaurant_id: string;
  name: string;
  sort: number;
};

export type TableShape = 'rect' | 'round';

export type FloorTable = {
  id: string;
  restaurant_id: string;
  zone_id: string;
  name: string;
  seats: number;
  shape: TableShape;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  combinable_group: string | null;
};

export type ElementKind = 'wall' | 'bar' | 'door' | 'plant' | 'label';

export type FloorElement = {
  id: string;
  restaurant_id: string;
  zone_id: string;
  kind: ElementKind;
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
};

export type BookingTable = {
  booking_id: string;
  table_id: string;
  restaurant_id: string;
};

/** Floor plan canvas size (SVG viewBox units). */
export const FLOOR_W = 1000;
export const FLOOR_H = 700;

export type CapacityRule = {
  id: string;
  restaurant_id: string;
  day_of_week: number | null;
  specific_date: string | null;
  time_slot: string | null;
  max_covers: number;
};

export type BookingStatus = 'confirmed' | 'cancelled';
export type BookingSource = 'widget' | 'manual';

export type Booking = {
  id: string;
  restaurant_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  party_size: number;
  date: string; // YYYY-MM-DD
  time_slot: string; // HH:MM:SS
  notes: string | null;
  table_number: string | null;
  status: BookingStatus;
  source: BookingSource;
  guest_lang: Lang;
  cancel_token: string;
  reminder_sent_at: string | null;
  service_status: ServiceStatus | null;
  created_at: string;
};

export type ServiceStatus = 'arrived' | 'seated' | 'no_show';

export type Owner = {
  id: string;
  restaurant_id: string;
  email: string;
};

export const MAX_PARTY_SIZE = 12;
export const BOOKING_HORIZON_DAYS = 60;
