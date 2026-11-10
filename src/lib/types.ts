export type DayHours = {
  open: string; // "18:00"
  close: string; // "22:00"
  closed: boolean;
};

/** Keyed by day of week: "0" = Sunday … "6" = Saturday */
export type OperatingHours = Record<string, DayHours>;

export type Lang = 'en' | 'pt' | 'de' | 'fr';

/** The product a business is on. Decided at onboarding (migration 0006). */
export type BusinessType = 'restaurant' | 'stays' | 'appointments';
export const BUSINESS_TYPES: BusinessType[] = ['restaurant', 'stays', 'appointments'];

export type PaymentMode = 'none' | 'deposit' | 'full';

/**
 * The tenant row. Still called `restaurants` in the database: it is the
 * business table for every vertical. Columns added by migration 0006 are
 * optional here so the app keeps working on a database that has not run it
 * yet (use `businessTypeOf()` instead of reading `business_type` directly).
 */
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
  business_type?: BusinessType;
  currency?: string;
  payment_mode?: PaymentMode;
  deposit_percent?: number;
  check_in_time?: string; // HH:MM:SS
  check_out_time?: string;
};

/** Alias for code that is not about restaurants. */
export type Business = Restaurant;

export function businessTypeOf(business: Pick<Restaurant, 'business_type'> | null | undefined): BusinessType {
  const t = business?.business_type;
  return t === 'stays' || t === 'appointments' ? t : 'restaurant';
}

export function currencyOf(business: Pick<Restaurant, 'currency'> | null | undefined): string {
  return business?.currency && /^[A-Z]{3}$/.test(business.currency) ? business.currency : 'EUR';
}

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

// ---------------------------------------------------------------------------
// Payments (shared by stays and appointments)
// ---------------------------------------------------------------------------

export type PaidBookingStatus = 'pending_payment' | 'confirmed' | 'cancelled';
export type PaymentStatus = 'none' | 'pending' | 'paid' | 'refunded';

export type PaymentAccount = {
  restaurant_id: string;
  stripe_account_id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
};

/** Minutes a guest has to finish paying before the dates / slot are released. */
export const PAYMENT_HOLD_MINUTES = 35;

// ---------------------------------------------------------------------------
// Stays
// ---------------------------------------------------------------------------

export type StayUnit = {
  id: string;
  restaurant_id: string;
  name: string;
  description: string | null;
  max_guests: number;
  base_price_cents: number;
  cleaning_fee_cents: number;
  min_nights: number;
  sort: number;
  active: boolean;
  ical_token: string;
  created_at: string;
};

export type StayRate = {
  id: string;
  restaurant_id: string;
  unit_id: string;
  start_date: string; // inclusive
  end_date: string; // inclusive
  price_cents: number;
  min_nights: number | null;
};

export type StayChannel = 'airbnb' | 'booking' | 'vrbo' | 'other';
export const STAY_CHANNELS: StayChannel[] = ['airbnb', 'booking', 'vrbo', 'other'];
export type StaySource = 'widget' | 'manual' | StayChannel;
export type StayStatus = 'checked_in' | 'checked_out' | 'no_show';

export type StayIcalFeed = {
  id: string;
  restaurant_id: string;
  unit_id: string;
  channel: StayChannel;
  url: string;
  last_synced_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  created_at: string;
};

export type StayReservation = {
  id: string;
  restaurant_id: string;
  unit_id: string;
  check_in: string; // YYYY-MM-DD
  check_out: string; // YYYY-MM-DD, exclusive
  guests: number;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  notes: string | null;
  status: PaidBookingStatus;
  source: StaySource;
  feed_id: string | null;
  external_uid: string | null;
  external_ref: string | null;
  stay_status: StayStatus | null;
  total_cents: number;
  amount_due_cents: number;
  paid_cents: number;
  currency: string;
  payment_status: PaymentStatus;
  stripe_session_id: string | null;
  hold_expires_at: string | null;
  guest_lang: Lang;
  cancel_token: string;
  reminder_sent_at: string | null;
  created_at: string;
};

export type StayBlock = {
  id: string;
  restaurant_id: string;
  unit_id: string;
  start_date: string;
  end_date: string; // exclusive
  reason: string | null;
};

export const STAY_HORIZON_DAYS = 540;
export const STAY_MAX_NIGHTS = 60;

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type Service = {
  id: string;
  restaurant_id: string;
  name: string;
  category: string | null;
  description: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  price_cents: number;
  active: boolean;
  sort: number;
};

export type Staff = {
  id: string;
  restaurant_id: string;
  name: string;
  title: string | null;
  color: string;
  /** null = follows the business's opening hours. */
  working_hours: OperatingHours | null;
  active: boolean;
  sort: number;
};

export type StaffService = {
  staff_id: string;
  service_id: string;
  restaurant_id: string;
};

export type StaffTimeOff = {
  id: string;
  restaurant_id: string;
  staff_id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
};

export type AppointmentServiceStatus = 'arrived' | 'completed' | 'no_show';

export type Appointment = {
  id: string;
  restaurant_id: string;
  service_id: string | null;
  staff_id: string;
  date: string;
  start_time: string; // HH:MM:SS
  end_time: string;
  busy_until: string;
  service_name: string;
  duration_minutes: number;
  price_cents: number;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  notes: string | null;
  status: PaidBookingStatus;
  source: 'widget' | 'manual';
  service_status: AppointmentServiceStatus | null;
  amount_due_cents: number;
  paid_cents: number;
  currency: string;
  payment_status: PaymentStatus;
  stripe_session_id: string | null;
  hold_expires_at: string | null;
  guest_lang: Lang;
  cancel_token: string;
  reminder_sent_at: string | null;
  created_at: string;
};

export const APPOINTMENT_HORIZON_DAYS = 90;
