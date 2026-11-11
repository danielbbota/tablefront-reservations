// Demo data for `npm run dev:local`: one business per product, each with an
// owner login. Everything is relative to today, lives in memory and is
// recreated on every start.
//
// These logins exist only in the local in-memory database.
export const DEMO_PASSWORD = 'demo-local-1234';
export const DEMO_LOGINS = {
  restaurant: 'restaurante@demo.test',
  stays: 'estadias@demo.test',
  appointments: 'marcacoes@demo.test',
};

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const HOURS = (open, close, closedDays = []) =>
  JSON.stringify(
    Object.fromEntries(
      ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open, close, closed: closedDays.includes(d) }])
    )
  );

export async function seedDemo(db) {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  async function business(name, slug, type, email, extra = {}) {
    const row = await one(
      `insert into restaurants (name, slug, business_type, language, timezone, operating_hours, slot_interval_minutes)
       values ($1, $2, $3, 'pt', 'Europe/Lisbon', $4, $5) returning id`,
      [name, slug, type, extra.hours ?? HOURS('12:00', '22:00'), extra.interval ?? 30]
    );
    const user = await one(`insert into auth.users (email, password) values ($1, $2) returning id`, [email, DEMO_PASSWORD]);
    await db.query(`insert into owners (id, restaurant_id, email) values ($1, $2, $3)`, [user.id, row.id, email]);
    return row.id;
  }

  // --- Restaurant (the original product, unchanged) -------------------------
  const restaurant = await business('Girassol Demo', 'girassol-demo', 'restaurant', DEMO_LOGINS.restaurant);
  await db.query(
    `insert into bookings (restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot, source)
     values ($1, 'Marta Lopes', '+351 912 000 111', 'marta@example.test', 4, $2, '20:00', 'widget')`,
    [restaurant, day(0)]
  );

  // --- Stays -----------------------------------------------------------------
  const stays = await business('Casa do Mar', 'casa-do-mar', 'stays', DEMO_LOGINS.stays);
  const unit = async (name, guests, price, cleaning, minNights, description, sort) =>
    (
      await one(
        `insert into stay_units (restaurant_id, name, max_guests, base_price_cents, cleaning_fee_cents, min_nights, description, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [stays, name, guests, price, cleaning, minNights, description, sort]
      )
    ).id;
  const duplo = await unit('Quarto Duplo Vista Mar', 2, 9500, 0, 1, 'Cama de casal, varanda com vista mar, pequeno-almoço incluído.', 0);
  const suite = await unit('Suíte Familiar', 4, 14500, 2500, 2, 'Dois quartos, kitchenette e terraço privado.', 1);
  const t1 = await unit('Apartamento T1 Jardim', 3, 11000, 3500, 2, 'Apartamento com cozinha equipada e jardim.', 2);
  const estudio = await unit('Estúdio Centro', 2, 7500, 2000, 1, 'Estúdio a 5 minutos da praia.', 3);

  await db.query(
    `insert into stay_rates (restaurant_id, unit_id, start_date, end_date, price_cents, min_nights)
     values ($1, $2, $3, $4, 16500, 3)`,
    [stays, suite, day(20), day(50)]
  );

  const feed = async (unitId, channel, url) =>
    (
      await one(
        `insert into stay_ical_feeds (restaurant_id, unit_id, channel, url, last_synced_at, last_status)
         values ($1, $2, $3, $4, now(), 'ok') returning id`,
        [stays, unitId, channel, url]
      )
    ).id;
  const airbnbFeed = await feed(duplo, 'airbnb', 'https://www.airbnb.com/calendar/ical/demo-duplo.ics?s=demo');
  const bookingFeed = await feed(t1, 'booking', 'https://ical.booking.com/v1/export?t=demo-t1');

  const reservation = (unitId, from, to, name, source, extra = {}) =>
    db.query(
      `insert into stay_reservations
         (restaurant_id, unit_id, check_in, check_out, guests, guest_name, guest_phone, guest_email,
          source, feed_id, external_uid, external_ref, total_cents, notes, guest_lang, stay_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pt',$15)`,
      [
        stays, unitId, day(from), day(to), extra.guests ?? 2, name, extra.phone ?? '', extra.email ?? '',
        source, extra.feed ?? null, extra.uid ?? null, extra.ref ?? null, extra.total ?? 0, extra.notes ?? null,
        extra.stayStatus ?? null,
      ]
    );

  await reservation(duplo, -2, 1, 'Inês Carvalho', 'widget', { phone: '+351 913 222 333', email: 'ines@example.test', total: 28500, stayStatus: 'checked_in' });
  await reservation(duplo, 2, 6, 'Airbnb HMDEMO4821', 'airbnb', { feed: airbnbFeed, uid: 'demo-1@airbnb.com', ref: 'https://www.airbnb.com/hosting/reservations/details/HMDEMO4821', notes: 'Airbnb · tel. …4821' });
  await reservation(duplo, 9, 12, 'Reserved', 'airbnb', { feed: airbnbFeed, uid: 'demo-2@airbnb.com' });
  await reservation(suite, 0, 4, 'Família Andrade', 'manual', { guests: 4, phone: '+351 965 111 222', total: 60500, notes: 'Chegam por volta das 18h. Berço no quarto.' });
  await reservation(suite, 7, 10, 'Tom Becker', 'widget', { guests: 3, phone: '+49 151 000 111', email: 'tom@example.test', total: 46000 });
  await reservation(t1, -4, 0, 'CLOSED - Not available', 'booking', { feed: bookingFeed, uid: 'demo-1@booking.com' });
  await reservation(t1, 3, 8, 'CLOSED - Not available', 'booking', { feed: bookingFeed, uid: 'demo-2@booking.com' });
  // A double booking: Booking.com sold nights that were already taken directly.
  await reservation(t1, 6, 9, 'Sofia Martins', 'widget', { phone: '+351 934 555 666', email: 'sofia@example.test', total: 36500 });
  await reservation(estudio, 1, 3, 'Luís Faria', 'manual', { phone: '+351 926 777 888', total: 17000 });

  await db.query(
    `insert into stay_blocks (restaurant_id, unit_id, start_date, end_date, reason) values ($1, $2, $3, $4, 'Pintura')`,
    [stays, estudio, day(5), day(8)]
  );

  // --- Appointments ----------------------------------------------------------
  const appts = await business('Barbearia Central', 'barbearia-central', 'appointments', DEMO_LOGINS.appointments, {
    hours: HOURS('09:00', '19:00', ['0']),
    interval: 15,
  });
  const service = async (name, category, minutes, price, buffer, sort) =>
    (
      await one(
        `insert into services (restaurant_id, name, category, duration_minutes, price_cents, buffer_minutes, sort)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [appts, name, category, minutes, price, buffer, sort]
      )
    ).id;
  const corte = await service('Corte de cabelo', 'Cabelo', 30, 1500, 0, 0);
  const corteBarba = await service('Corte + barba', 'Cabelo', 45, 2200, 5, 1);
  const barba = await service('Barba', 'Barba', 20, 1000, 0, 2);
  const coloracao = await service('Coloração', 'Cabelo', 60, 3500, 10, 3);

  const member = async (name, title, color, sort) =>
    (
      await one(
        `insert into staff (restaurant_id, name, title, color, sort) values ($1, $2, $3, $4, $5) returning id`,
        [appts, name, title, color, sort]
      )
    ).id;
  const rui = await member('Rui', 'Barbeiro sénior', '#8c4225', 0);
  const ana = await member('Ana', 'Cabeleireira', '#2f6f8f', 1);
  const tiago = await member('Tiago', 'Barbeiro', '#4a7c4e', 2);

  for (const [who, what] of [
    [rui, corte], [rui, corteBarba], [rui, barba],
    [ana, corte], [ana, coloracao],
    [tiago, corte], [tiago, barba],
  ]) {
    await db.query(`insert into staff_services (restaurant_id, staff_id, service_id) values ($1, $2, $3)`, [appts, who, what]);
  }

  const appointment = (staffId, serviceId, name, minutes, price, offset, start, end, busy, extra = {}) =>
    db.query(
      `insert into appointments
         (restaurant_id, service_id, staff_id, date, start_time, end_time, busy_until, service_name,
          duration_minutes, price_cents, guest_name, guest_phone, guest_email, source, service_status, guest_lang)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pt')`,
      [
        appts, serviceId, staffId, day(offset), start, end, busy, name, minutes, price,
        extra.guest ?? 'Cliente', extra.phone ?? '', extra.email ?? '', extra.source ?? 'widget', extra.status ?? null,
      ]
    );
  await appointment(rui, corte, 'Corte de cabelo', 30, 1500, 0, '09:30', '10:00', '10:00', { guest: 'Pedro Nunes', phone: '+351 911 222 333', status: 'completed' });
  await appointment(rui, corteBarba, 'Corte + barba', 45, 2200, 0, '11:00', '11:45', '11:50', { guest: 'João Reis', phone: '+351 917 444 555', email: 'joao@example.test' });
  await appointment(rui, barba, 'Barba', 20, 1000, 0, '15:00', '15:20', '15:20', { guest: 'Miguel Sá', source: 'manual' });
  await appointment(ana, coloracao, 'Coloração', 60, 3500, 0, '10:00', '11:00', '11:10', { guest: 'Carla Dias', phone: '+351 938 000 999', email: 'carla@example.test' });
  await appointment(ana, corte, 'Corte de cabelo', 30, 1500, 0, '14:30', '15:00', '15:00', { guest: 'Beatriz Lima' });
  await appointment(tiago, corte, 'Corte de cabelo', 30, 1500, 0, '12:00', '12:30', '12:30', { guest: 'André Pinto', status: 'arrived' });
  await appointment(tiago, barba, 'Barba', 20, 1000, 1, '10:00', '10:20', '10:20', { guest: 'Nuno Alves', phone: '+351 919 123 456' });

  return { restaurant, stays, appointments: appts };
}
