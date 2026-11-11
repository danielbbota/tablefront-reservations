// Database behaviour of migration 0006 (stays + appointments), proven against
// a real in-process Postgres with every migration applied (tests/helpers/pglite).
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, migratedDatabase, pgError } from '../helpers/pglite';

let db: PGlite;

// Two tenants, one owner each.
const A = { id: '', owner: '', unit: '', staff: '', service: '' };
const B = { id: '', owner: '', unit: '', staff: '', service: '' };

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

async function seedTenant(target: typeof A, slug: string, type: 'stays' | 'appointments') {
  target.id = (
    await one<{ id: string }>(
      `insert into restaurants (name, slug, business_type) values ($1, $1, $2) returning id`,
      [slug, type]
    )
  ).id;
  target.owner = (await one<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`${slug}@example.test`])).id;
  await db.query(`insert into owners (id, restaurant_id, email) values ($1, $2, $3)`, [
    target.owner,
    target.id,
    `${slug}@example.test`,
  ]);
  target.unit = (
    await one<{ id: string }>(
      `insert into stay_units (restaurant_id, name, base_price_cents) values ($1, 'Room', 8000) returning id`,
      [target.id]
    )
  ).id;
  target.staff = (
    await one<{ id: string }>(`insert into staff (restaurant_id, name) values ($1, 'Ana') returning id`, [target.id])
  ).id;
  target.service = (
    await one<{ id: string }>(
      `insert into services (restaurant_id, name, duration_minutes, price_cents) values ($1, 'Cut', 30, 1500) returning id`,
      [target.id]
    )
  ).id;
}

const stay = (
  tenant: typeof A,
  checkIn: string,
  checkOut: string,
  opts: { unit?: string; hold?: number; source?: string } = {}
) =>
  db.query<{ id: string; status: string; source: string; payment_status: string; amount_due_cents: number; hold_expires_at: string | null }>(
    `select * from create_stay_reservation($1,$2,$3,$4,2,'Guest','+351','g@example.test',null,$5,'pt',16000,4800,'EUR',$6)`,
    [tenant.id, opts.unit ?? tenant.unit, checkIn, checkOut, opts.source ?? 'widget', opts.hold ?? 0]
  );

const appointment = (
  tenant: typeof A,
  date: string,
  start: string,
  end: string,
  busyUntil: string,
  opts: { staff?: string; hold?: number } = {}
) =>
  db.query<{ id: string; status: string }>(
    `select * from create_appointment($1,$2,$3,$4,$5,$6,$7,'Cut',30,1500,'Guest','+351','g@example.test',null,'widget','pt',450,'EUR',$8)`,
    [tenant.id, tenant.service, opts.staff ?? tenant.staff, date, start, end, busyUntil, opts.hold ?? 0]
  );

beforeAll(async () => {
  db = await migratedDatabase();
  await seedTenant(A, 'tenant-a', 'stays');
  await seedTenant(B, 'tenant-b', 'appointments');
}, 60_000);

describe('migration 0006 on an existing restaurant database', () => {
  it('existing businesses become restaurants with payment off', async () => {
    const row = await one<{ business_type: string; payment_mode: string; currency: string }>(
      `insert into restaurants (name, slug) values ('Old', 'old') returning business_type, payment_mode, currency`
    );
    expect(row).toEqual({ business_type: 'restaurant', payment_mode: 'none', currency: 'EUR' });
  });

  it('refuses an unknown business type', async () => {
    const err = await pgError(() =>
      db.query(`insert into restaurants (name, slug, business_type) values ('X', 'x', 'gym')`)
    );
    expect(err.message).toMatch(/business_type/);
  });
});

describe('create_stay_reservation', () => {
  it('confirms a free stay as a direct booking', async () => {
    const { rows } = await stay(A, '2030-03-01', '2030-03-04');
    expect(rows[0]).toMatchObject({ status: 'confirmed', source: 'widget', payment_status: 'none', amount_due_cents: 0 });
    expect(rows[0].hold_expires_at).toBeNull();
  });

  it('refuses any stay sharing a night with it', async () => {
    for (const [checkIn, checkOut] of [
      ['2030-03-01', '2030-03-04'], // identical
      ['2030-02-27', '2030-03-02'], // overlaps the start
      ['2030-03-03', '2030-03-06'], // overlaps the end
      ['2030-03-02', '2030-03-03'], // inside
      ['2030-02-20', '2030-03-20'], // around
    ]) {
      const err = await pgError(() => stay(A, checkIn, checkOut));
      expect(err.message).toMatch(/DATES_TAKEN/);
    }
  });

  it('allows back-to-back stays: check-out day is the next guest’s check-in day', async () => {
    await expect(stay(A, '2030-03-04', '2030-03-06')).resolves.toBeTruthy();
    await expect(stay(A, '2030-02-27', '2030-03-01')).resolves.toBeTruthy();
  });

  it('a cancelled stay frees its nights', async () => {
    const { rows } = await stay(A, '2030-04-01', '2030-04-05');
    await db.query(`update stay_reservations set status = 'cancelled' where id = $1`, [rows[0].id]);
    await expect(stay(A, '2030-04-02', '2030-04-04')).resolves.toBeTruthy();
  });

  it('a payment hold blocks the nights until it expires, then no longer', async () => {
    const { rows } = await stay(A, '2030-05-01', '2030-05-05', { hold: 35 });
    expect(rows[0]).toMatchObject({ status: 'pending_payment', payment_status: 'pending', amount_due_cents: 4800 });
    expect(rows[0].hold_expires_at).not.toBeNull();

    expect((await pgError(() => stay(A, '2030-05-02', '2030-05-03'))).message).toMatch(/DATES_TAKEN/);

    await db.query(`update stay_reservations set hold_expires_at = now() - interval '1 minute' where id = $1`, [rows[0].id]);
    await expect(stay(A, '2030-05-02', '2030-05-03')).resolves.toBeTruthy();
  });

  it('an owner block makes the nights unavailable', async () => {
    await db.query(
      `insert into stay_blocks (restaurant_id, unit_id, start_date, end_date) values ($1, $2, '2030-06-10', '2030-06-15')`,
      [A.id, A.unit]
    );
    expect((await pgError(() => stay(A, '2030-06-14', '2030-06-16'))).message).toMatch(/DATES_TAKEN/);
    await expect(stay(A, '2030-06-15', '2030-06-16')).resolves.toBeTruthy();
  });

  it('a channel reservation (imported by sync) blocks direct bookings too', async () => {
    const feed = await one<{ id: string }>(
      `insert into stay_ical_feeds (restaurant_id, unit_id, channel, url) values ($1, $2, 'airbnb', 'https://www.airbnb.com/calendar/ical/1.ics') returning id`,
      [A.id, A.unit]
    );
    await db.query(
      `insert into stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name, source, feed_id, external_uid)
       values ($1, $2, '2030-07-01', '2030-07-08', 'Reserved', 'airbnb', $3, 'uid-1@airbnb.com')`,
      [A.id, A.unit, feed.id]
    );
    expect((await pgError(() => stay(A, '2030-07-05', '2030-07-10'))).message).toMatch(/DATES_TAKEN/);
  });

  it('never books a unit under another tenant’s id', async () => {
    const err = await pgError(() => stay(A, '2031-01-01', '2031-01-03', { unit: B.unit }));
    expect(err.message).toMatch(/UNIT_NOT_FOUND/);
  });

  it('stores anything that is not "manual" as a widget booking', async () => {
    const manual = await stay(A, '2031-02-01', '2031-02-02', { source: 'manual' });
    const spoofed = await stay(A, '2031-02-02', '2031-02-03', { source: 'airbnb' });
    expect(manual.rows[0].source).toBe('manual');
    expect(spoofed.rows[0].source).toBe('widget');
  });

  it('refuses a departure on or before the arrival', async () => {
    expect((await pgError(() => stay(A, '2031-03-05', '2031-03-05'))).code).toBe('23514');
  });
});

describe('create_appointment', () => {
  it('books a free slot', async () => {
    const { rows } = await appointment(B, '2030-03-01', '10:00', '10:30', '10:40');
    expect(rows[0].status).toBe('confirmed');
  });

  it('refuses a slot that overlaps the appointment or its buffer', async () => {
    for (const [start, end, busy] of [
      ['10:00', '10:30', '10:30'],
      ['09:45', '10:15', '10:15'],
      ['10:15', '10:45', '10:45'],
      ['10:30', '11:00', '11:00'], // starts inside the 10-minute buffer
    ]) {
      expect((await pgError(() => appointment(B, '2030-03-01', start, end, busy))).message).toMatch(/SLOT_TAKEN/);
    }
  });

  it('allows the slot right after the buffer, and right before the appointment', async () => {
    await expect(appointment(B, '2030-03-01', '10:40', '11:10', '11:10')).resolves.toBeTruthy();
    await expect(appointment(B, '2030-03-01', '09:30', '10:00', '10:00')).resolves.toBeTruthy();
  });

  it('another professional, or another day, is unaffected', async () => {
    const other = await one<{ id: string }>(`insert into staff (restaurant_id, name) values ($1, 'Rui') returning id`, [B.id]);
    await expect(appointment(B, '2030-03-01', '10:00', '10:30', '10:30', { staff: other.id })).resolves.toBeTruthy();
    await expect(appointment(B, '2030-03-02', '10:00', '10:30', '10:30')).resolves.toBeTruthy();
  });

  it('a payment hold blocks the slot only while it is live', async () => {
    const { rows } = await appointment(B, '2030-03-05', '15:00', '15:30', '15:30', { hold: 35 });
    expect(rows[0].status).toBe('pending_payment');
    expect((await pgError(() => appointment(B, '2030-03-05', '15:00', '15:30', '15:30'))).message).toMatch(/SLOT_TAKEN/);
    await db.query(`update appointments set hold_expires_at = now() - interval '1 minute' where id = $1`, [rows[0].id]);
    await expect(appointment(B, '2030-03-05', '15:00', '15:30', '15:30')).resolves.toBeTruthy();
  });

  it('never books another tenant’s professional', async () => {
    const err = await pgError(() => appointment(B, '2030-03-06', '10:00', '10:30', '10:30', { staff: A.staff }));
    expect(err.message).toMatch(/STAFF_NOT_FOUND/);
  });

  it('deleting a service keeps the appointment and its snapshot; a booked professional cannot be deleted', async () => {
    const svc = await one<{ id: string }>(
      `insert into services (restaurant_id, name, duration_minutes) values ($1, 'Shave', 15) returning id`,
      [B.id]
    );
    const appt = await one<{ id: string }>(
      `insert into appointments (restaurant_id, service_id, staff_id, date, start_time, end_time, busy_until, service_name, duration_minutes, guest_name)
       values ($1, $2, $3, '2030-09-01', '09:00', '09:15', '09:15', 'Shave', 15, 'Guest') returning id`,
      [B.id, svc.id, B.staff]
    );
    await db.query(`delete from services where id = $1`, [svc.id]);
    const kept = await one<{ service_id: string | null; service_name: string; restaurant_id: string }>(
      `select service_id, service_name, restaurant_id from appointments where id = $1`,
      [appt.id]
    );
    expect(kept).toEqual({ service_id: null, service_name: 'Shave', restaurant_id: B.id });

    expect((await pgError(() => db.query(`delete from staff where id = $1`, [B.staff]))).code).toBe('23503');
  });
});

describe('who may call the booking functions', () => {
  it.each(['anon', 'authenticated'] as const)('%s cannot execute them', async (role) => {
    const stayErr = await asRole(db, role, role === 'authenticated' ? A.owner : null, () =>
      pgError(() => stay(A, '2032-01-01', '2032-01-02'))
    );
    const apptErr = await asRole(db, role, role === 'authenticated' ? B.owner : null, () =>
      pgError(() => appointment(B, '2032-01-01', '10:00', '10:30', '10:30'))
    );
    expect(stayErr.code).toBe('42501');
    expect(apptErr.code).toBe('42501');
  });

  it('service_role can', async () => {
    await expect(asRole(db, 'service_role', null, () => stay(A, '2032-01-01', '2032-01-02'))).resolves.toBeTruthy();
  });
});

describe('tenant isolation', () => {
  it('an owner sees only their own rows in every new table', async () => {
    const counts = await asRole(db, 'authenticated', A.owner, async () => ({
      units: (await db.query<{ restaurant_id: string }>(`select restaurant_id from stay_units`)).rows,
      reservations: (await db.query<{ restaurant_id: string }>(`select restaurant_id from stay_reservations`)).rows,
      staff: (await db.query<{ restaurant_id: string }>(`select restaurant_id from staff`)).rows,
      services: (await db.query<{ restaurant_id: string }>(`select restaurant_id from services`)).rows,
      appointments: (await db.query<{ restaurant_id: string }>(`select restaurant_id from appointments`)).rows,
    }));
    expect(counts.units.length).toBeGreaterThan(0);
    for (const rows of Object.values(counts)) {
      expect(rows.every((r) => r.restaurant_id === A.id)).toBe(true);
    }
    // Tenant B's appointments exist, but not for owner A.
    expect(counts.appointments).toHaveLength(0);
  });

  it('an owner cannot write into another tenant', async () => {
    const insertErr = await asRole(db, 'authenticated', A.owner, () =>
      pgError(() => db.query(`insert into stay_units (restaurant_id, name) values ($1, 'Intruder')`, [B.id]))
    );
    expect(insertErr.code).toBe('42501');

    const updated = await asRole(db, 'authenticated', A.owner, () =>
      db.query(`update staff set name = 'Hacked' where restaurant_id = $1 returning id`, [B.id])
    );
    expect(updated.rows).toHaveLength(0);
  });

  it('a child row cannot point at another tenant’s parent, even for the service role', async () => {
    // Own restaurant_id, someone else's unit / staff / service.
    const rate = await pgError(() =>
      db.query(
        `insert into stay_rates (restaurant_id, unit_id, start_date, end_date, price_cents) values ($1, $2, '2030-01-01', '2030-01-31', 1)`,
        [A.id, B.unit]
      )
    );
    const link = await pgError(() =>
      db.query(`insert into staff_services (restaurant_id, staff_id, service_id) values ($1, $2, $3)`, [
        A.id,
        A.staff,
        B.service,
      ])
    );
    const reservation = await pgError(() =>
      db.query(
        `insert into stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name) values ($1, $2, '2033-01-01', '2033-01-02', 'X')`,
        [A.id, B.unit]
      )
    );
    expect([rate.code, link.code, reservation.code]).toEqual(['23503', '23503', '23503']);
  });

  it('owners can read but not write their Stripe link', async () => {
    await db.query(`insert into payment_accounts (restaurant_id, stripe_account_id, charges_enabled) values ($1, 'acct_a', true)`, [A.id]);
    await db.query(`insert into payment_accounts (restaurant_id, stripe_account_id) values ($1, 'acct_b')`, [B.id]);

    const seen = await asRole(db, 'authenticated', A.owner, () =>
      db.query<{ stripe_account_id: string }>(`select stripe_account_id from payment_accounts`)
    );
    expect(seen.rows).toEqual([{ stripe_account_id: 'acct_a' }]);

    const hijack = await asRole(db, 'authenticated', A.owner, () =>
      db.query(`update payment_accounts set stripe_account_id = 'acct_b_stolen' returning restaurant_id`)
    );
    expect(hijack.rows).toHaveLength(0);
  });

  it('an owner cannot switch their own business to another product', async () => {
    const err = await asRole(db, 'authenticated', A.owner, () =>
      pgError(() => db.query(`update restaurants set business_type = 'restaurant' where id = $1`, [A.id]))
    );
    expect(err.code).toBe('42501');

    // …but can still edit ordinary settings, and TableFront (service role) can switch it.
    const renamed = await asRole(db, 'authenticated', A.owner, () =>
      db.query(`update restaurants set currency = 'GBP' where id = $1 returning currency`, [A.id])
    );
    expect(renamed.rows).toEqual([{ currency: 'GBP' }]);
    await expect(
      asRole(db, 'service_role', null, () =>
        db.query(`update restaurants set business_type = 'stays' where id = $1`, [A.id])
      )
    ).resolves.toBeTruthy();
  });
});

describe('channel feeds', () => {
  it('removing a feed removes the reservations it imported, and only those', async () => {
    const feed = await one<{ id: string }>(
      `insert into stay_ical_feeds (restaurant_id, unit_id, channel, url) values ($1, $2, 'booking', 'https://ical.booking.com/v1/export?t=x') returning id`,
      [A.id, A.unit]
    );
    await db.query(
      `insert into stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name, source, feed_id, external_uid)
       values ($1, $2, '2034-01-01', '2034-01-03', 'CLOSED - Not available', 'booking', $3, 'b-1')`,
      [A.id, A.unit, feed.id]
    );
    const direct = await one<{ n: number }>(`select count(*)::int as n from stay_reservations where feed_id is null`);
    await db.query(`delete from stay_ical_feeds where id = $1`, [feed.id]);

    expect((await one<{ n: number }>(`select count(*)::int as n from stay_reservations where external_uid = 'b-1'`)).n).toBe(0);
    expect((await one<{ n: number }>(`select count(*)::int as n from stay_reservations where feed_id is null`)).n).toBe(direct.n);
  });

  it('the same channel event cannot be imported twice for a feed', async () => {
    const feed = await one<{ id: string }>(
      `insert into stay_ical_feeds (restaurant_id, unit_id, channel, url) values ($1, $2, 'vrbo', 'https://www.vrbo.com/icalendar/x.ics') returning id`,
      [A.id, A.unit]
    );
    const insert = () =>
      db.query(
        `insert into stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name, source, feed_id, external_uid)
         values ($1, $2, '2035-01-01', '2035-01-03', 'Reserved', 'vrbo', $3, 'dup')`,
        [A.id, A.unit, feed.id]
      );
    await insert();
    expect((await pgError(insert)).code).toBe('23505');
  });

  it('only https feed addresses are stored', async () => {
    const err = await pgError(() =>
      db.query(
        `insert into stay_ical_feeds (restaurant_id, unit_id, channel, url) values ($1, $2, 'other', 'http://example.com/a.ics')`,
        [A.id, A.unit]
      )
    );
    expect(err.code).toBe('23514');
  });
});
