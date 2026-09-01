'use server';

import { revalidatePath } from 'next/cache';
import { createServerSupabase } from '@/lib/supabase/server';
import { normalizeSlot, toMinutes } from '@/lib/availability';
import {
  FLOOR_H,
  FLOOR_W,
  type Booking,
  type ElementKind,
  type FloorTable,
  type Restaurant,
  type TableShape,
} from '@/lib/types';

/**
 * Floor plan + table assignment actions. All run under the owner's RLS
 * session; every row carries restaurant_id, so tenant isolation holds at
 * the database layer. These are called imperatively from client components
 * and return result objects (no redirects).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHAPES: TableShape[] = ['rect', 'round'];
const KINDS: ElementKind[] = ['wall', 'bar', 'door', 'plant', 'label'];

export type ZonePayload = {
  id: string;
  name: string;
  sort: number;
  tables: {
    id: string;
    name: string;
    seats: number;
    shape: TableShape;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    combinable_group: string | null;
  }[];
  elements: {
    id: string;
    kind: ElementKind;
    label: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
  }[];
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

export async function saveFloorPlan(zones: ZonePayload[]): Promise<{ ok?: true; error?: string }> {
  const supabase = await createServerSupabase();
  const { data: owner } = await supabase
    .from('owners')
    .select('restaurant_id')
    .single<{ restaurant_id: string }>();
  if (!owner) return { error: 'Not logged in.' };
  const rid = owner.restaurant_id;

  if (!Array.isArray(zones) || zones.length === 0 || zones.length > 8)
    return { error: 'Invalid floor plan.' };

  const zoneRows = [];
  const tableRows = [];
  const elementRows = [];

  for (const [i, z] of zones.entries()) {
    if (!UUID_RE.test(z.id)) return { error: 'Invalid zone id.' };
    const name = String(z.name ?? '').trim().slice(0, 40) || `Zone ${i + 1}`;
    zoneRows.push({ id: z.id, restaurant_id: rid, name, sort: i });

    if (!Array.isArray(z.tables) || z.tables.length > 120) return { error: 'Too many tables.' };
    for (const t of z.tables) {
      if (!UUID_RE.test(t.id)) return { error: 'Invalid table id.' };
      tableRows.push({
        id: t.id,
        restaurant_id: rid,
        zone_id: z.id,
        name: String(t.name ?? '').trim().slice(0, 20) || '?',
        seats: clamp(Math.round(Number(t.seats)), 1, 30),
        shape: SHAPES.includes(t.shape) ? t.shape : 'rect',
        x: clamp(t.x, 0, FLOOR_W - 20),
        y: clamp(t.y, 0, FLOOR_H - 20),
        w: clamp(t.w, 30, FLOOR_W),
        h: clamp(t.h, 30, FLOOR_H),
        rotation: clamp(t.rotation, -360, 360),
        combinable_group:
          String(t.combinable_group ?? '').trim().slice(0, 20) || null,
      });
    }

    if (!Array.isArray(z.elements) || z.elements.length > 200)
      return { error: 'Too many elements.' };
    for (const el of z.elements) {
      if (!UUID_RE.test(el.id)) return { error: 'Invalid element id.' };
      elementRows.push({
        id: el.id,
        restaurant_id: rid,
        zone_id: z.id,
        kind: KINDS.includes(el.kind) ? el.kind : 'wall',
        label: String(el.label ?? '').trim().slice(0, 40) || null,
        x: clamp(el.x, 0, FLOOR_W - 10),
        y: clamp(el.y, 0, FLOOR_H - 10),
        w: clamp(el.w, 10, FLOOR_W),
        h: clamp(el.h, 6, FLOOR_H),
        rotation: clamp(el.rotation, -360, 360),
      });
    }
  }

  // Upsert everything, then remove rows that are no longer in the plan.
  const { error: zErr } = await supabase.from('floor_zones').upsert(zoneRows);
  if (zErr) return { error: zErr.message };
  if (tableRows.length) {
    const { error } = await supabase.from('floor_tables').upsert(tableRows);
    if (error) return { error: error.message };
  }
  if (elementRows.length) {
    const { error } = await supabase.from('floor_elements').upsert(elementRows);
    if (error) return { error: error.message };
  }

  const keepZones = zoneRows.map((z) => z.id);
  const keepTables = tableRows.map((t) => t.id);
  const keepElements = elementRows.map((e) => e.id);

  // Deleting a zone cascades its tables/elements; deleting a table cascades
  // its booking assignments — exactly the intended behavior.
  const del = supabase.from('floor_zones').delete().eq('restaurant_id', rid);
  await (keepZones.length ? del.not('id', 'in', `(${keepZones.join(',')})`) : del);

  const delT = supabase.from('floor_tables').delete().eq('restaurant_id', rid);
  await (keepTables.length ? delT.not('id', 'in', `(${keepTables.join(',')})`) : delT);

  const delE = supabase.from('floor_elements').delete().eq('restaurant_id', rid);
  await (keepElements.length ? delE.not('id', 'in', `(${keepElements.join(',')})`) : delE);

  revalidatePath('/floor-plan');
  revalidatePath('/day');
  return { ok: true };
}

/**
 * Assign a booking to a table (tableId null = unassign). Returns
 * {conflict: true} when the table already has an overlapping booking and
 * force was not set — the client shows an "assign anyway" confirmation.
 */
export async function assignBookingTable(
  bookingId: string,
  tableId: string | null,
  force = false
): Promise<{ ok?: true; error?: string; conflict?: true }> {
  const supabase = await createServerSupabase();
  const { data: owner } = await supabase
    .from('owners')
    .select('restaurant_id')
    .single<{ restaurant_id: string }>();
  if (!owner) return { error: 'Not logged in.' };
  if (!UUID_RE.test(bookingId)) return { error: 'Invalid booking.' };

  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle<Booking>();
  if (!booking) return { error: 'Booking not found.' };

  if (tableId === null) {
    await supabase.from('booking_tables').delete().eq('booking_id', bookingId);
    await supabase.from('bookings').update({ table_number: null }).eq('id', bookingId);
    revalidatePath('/day');
    return { ok: true };
  }

  if (!UUID_RE.test(tableId)) return { error: 'Invalid table.' };
  const { data: table } = await supabase
    .from('floor_tables')
    .select('id, name')
    .eq('id', tableId)
    .maybeSingle<Pick<FloorTable, 'id' | 'name'>>();
  if (!table) return { error: 'Table not found.' };

  if (!force) {
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('turn_time_minutes')
      .single<Pick<Restaurant, 'turn_time_minutes'>>();
    const turn = restaurant?.turn_time_minutes ?? 90;

    const { data: links } = await supabase
      .from('booking_tables')
      .select('booking_id')
      .eq('table_id', tableId);
    const otherIds = (links ?? [])
      .map((l) => l.booking_id)
      .filter((id) => id !== bookingId);

    if (otherIds.length) {
      const { data: others } = await supabase
        .from('bookings')
        .select('id, time_slot, status, date')
        .in('id', otherIds)
        .eq('date', booking.date)
        .eq('status', 'confirmed')
        .returns<Pick<Booking, 'id' | 'time_slot' | 'status' | 'date'>[]>();
      const start = toMinutes(normalizeSlot(booking.time_slot));
      const overlaps = (others ?? []).some(
        (o) => Math.abs(toMinutes(normalizeSlot(o.time_slot)) - start) < turn
      );
      if (overlaps) return { conflict: true };
    }
  }

  await supabase.from('booking_tables').delete().eq('booking_id', bookingId);
  const { error: insErr } = await supabase.from('booking_tables').insert({
    booking_id: bookingId,
    table_id: tableId,
    restaurant_id: owner.restaurant_id,
  });
  if (insErr) return { error: insErr.message };
  await supabase.from('bookings').update({ table_number: table.name }).eq('id', bookingId);

  revalidatePath('/day');
  return { ok: true };
}

/** Seat a walk-in directly from the map: creates a seated manual booking. */
export async function seatWalkIn(
  tableId: string,
  date: string,
  time: string,
  partySize: number,
  guestLabel: string
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createServerSupabase();
  const { data: owner } = await supabase
    .from('owners')
    .select('restaurant_id')
    .single<{ restaurant_id: string }>();
  if (!owner) return { error: 'Not logged in.' };

  if (!UUID_RE.test(tableId)) return { error: 'Invalid table.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    return { error: 'Invalid date/time.' };
  const party = clamp(Math.round(Number(partySize)), 1, 50);

  const [{ data: table }, { data: restaurant }] = await Promise.all([
    supabase
      .from('floor_tables')
      .select('id, name')
      .eq('id', tableId)
      .maybeSingle<Pick<FloorTable, 'id' | 'name'>>(),
    supabase
      .from('restaurants')
      .select('language')
      .single<Pick<Restaurant, 'language'>>(),
  ]);
  if (!table) return { error: 'Table not found.' };

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: owner.restaurant_id,
      guest_name: String(guestLabel ?? 'Walk-in').slice(0, 40) || 'Walk-in',
      guest_phone: '',
      guest_email: '',
      party_size: party,
      date,
      time_slot: time,
      status: 'confirmed',
      source: 'manual',
      service_status: 'seated',
      guest_lang: restaurant?.language ?? 'en',
      table_number: table.name,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !booking) return { error: error?.message ?? 'Could not seat walk-in.' };

  await supabase.from('booking_tables').insert({
    booking_id: booking.id,
    table_id: tableId,
    restaurant_id: owner.restaurant_id,
  });

  revalidatePath('/day');
  return { ok: true };
}
