// The appointments dashboard actions, run for real against a small in-memory
// stand-in for the tables they touch. RLS is not modelled here (one business
// only): tenant isolation is the database's job and is covered by the RLS
// suite. redirect() is turned into a catchable signal, emails are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string };

const state: {
  tables: Record<string, Row[]>;
  /** Force an error for "<table>.<op>" (op = select | insert | update | delete). */
  errors: Record<string, DbError>;
  rpcCalls: { name: string; args: Row }[];
  rpc: (args: Row) => { data: Row | null; error: DbError | null };
  seq: number;
} = { tables: {}, errors: {}, rpcCalls: [], rpc: () => ({ data: null, error: null }), seq: 0 };

const nextId = () => `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`;

/** The slice of the PostgREST builder the actions use. */
class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private patch: Row = {};
  private fresh: Row[] = [];
  constructor(private table: string) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  returns() {
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.fresh = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...(r.id || this.table === 'staff_services' ? {} : { id: nextId() }), ...r }));
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((r) => r[column] === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push((r) => r[column] !== value);
    return this;
  }
  private run(): { data: Row[]; error: DbError | null } {
    const forced = state.errors[`${this.table}.${this.op}`];
    if (forced) return { data: [], error: forced };
    const rows = (state.tables[this.table] ??= []);
    // Like the real client, hand back copies: the stored rows stay private.
    const copies = (list: Row[]) => list.map((r) => ({ ...r }));
    if (this.op === 'insert') {
      rows.push(...this.fresh);
      return { data: copies(this.fresh), error: null };
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') matched.forEach((r) => Object.assign(r, this.patch));
    if (this.op === 'delete') state.tables[this.table] = rows.filter((r) => !matched.includes(r));
    return { data: copies(matched), error: null };
  }
  maybeSingle() {
    const { data, error } = this.run();
    return Promise.resolve({ data: data[0] ?? null, error });
  }
  single() {
    const { data, error } = this.run();
    return Promise.resolve(
      error || data.length !== 1
        ? { data: null, error: error ?? { message: 'not exactly one row' } }
        : { data: data[0], error: null }
    );
  }
  then<T>(resolve: (value: { data: Row[]; error: DbError | null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

const client = {
  from: (table: string) => new Query(table),
  rpc: (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });
    return { single: () => Promise.resolve(state.rpc(args)) };
  },
};
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: async () => client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sendAppointmentConfirmation = vi.fn(async () => {});
const sendAppointmentCancellation = vi.fn(async () => {});
vi.mock('@/lib/appointments/email', () => ({ sendAppointmentConfirmation, sendAppointmentCancellation }));
const expireSession = vi.fn(async () => {});
vi.mock('@/lib/payments/checkout', () => ({ expireSession }));

const actions = await import('@/app/appointments-actions');

// --- fixtures ----------------------------------------------------------------

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const CUT = 'c0000000-0000-4000-8000-000000000001';
const COLOUR = 'c0000000-0000-4000-8000-000000000002';
const ANA = 'a0000000-0000-4000-8000-000000000001';
const RUI = 'a0000000-0000-4000-8000-000000000002';
const DAY = '2026-10-26';

function appointment(partial: Row = {}): Row {
  return {
    id: nextId(),
    restaurant_id: BUSINESS,
    service_id: CUT,
    staff_id: ANA,
    date: DAY,
    start_time: '10:00:00',
    end_time: '10:30:00',
    busy_until: '10:30:00',
    service_name: 'Corte',
    duration_minutes: 30,
    price_cents: 1500,
    guest_name: 'Ada',
    guest_phone: '',
    guest_email: 'ada@example.test',
    notes: null,
    status: 'confirmed',
    source: 'widget',
    service_status: null,
    payment_status: 'none',
    paid_cents: 0,
    stripe_session_id: null,
    hold_expires_at: null,
    ...partial,
  };
}

beforeEach(() => {
  state.seq = 0;
  state.errors = {};
  state.rpcCalls = [];
  state.rpc = (args) => ({
    data: { id: nextId(), guest_email: args.p_guest_email, staff_id: args.p_staff_id, date: args.p_date },
    error: null,
  });
  state.tables = {
    // Portuguese business: error messages must come back in Portuguese.
    restaurants: [{ id: BUSINESS, name: 'Barbearia', language: 'pt', currency: 'EUR', timezone: 'UTC' }],
    services: [
      { id: CUT, restaurant_id: BUSINESS, name: 'Corte', duration_minutes: 30, buffer_minutes: 0, price_cents: 1500, active: true },
      { id: COLOUR, restaurant_id: BUSINESS, name: 'Coloração', duration_minutes: 60, buffer_minutes: 15, price_cents: 5000, active: true },
    ],
    staff: [
      { id: ANA, restaurant_id: BUSINESS, name: 'Ana', active: true, working_hours: null },
      { id: RUI, restaurant_id: BUSINESS, name: 'Rui', active: true, working_hours: null },
    ],
    staff_services: [],
    staff_time_off: [],
    appointments: [],
    payment_accounts: [],
  };
  sendAppointmentConfirmation.mockClear();
  sendAppointmentCancellation.mockClear();
  expireSession.mockClear();
});

/** Run an action to its redirect and return where it went ('' = returned normally). */
async function go(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (err) {
    if (err instanceof RedirectSignal) return decodeURIComponent(err.to);
    throw err;
  }
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return fd;
}

const manual = (overrides: Record<string, string> = {}) =>
  form({ serviceId: COLOUR, staffId: RUI, date: DAY, time: '14:00', name: 'Bia', phone: '912', email: 'bia@example.test', notes: ' raiz ', ...overrides });

// --- appointments ------------------------------------------------------------

describe('createManualAppointment', () => {
  it('books through create_appointment as a manual, uncharged appointment and emails the client', async () => {
    const to = await go(() => actions.createManualAppointment(manual()));
    expect(to).toBe(`/agenda?date=${DAY}`);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe('create_appointment');
    expect(state.rpcCalls[0].args).toEqual({
      p_restaurant_id: BUSINESS,
      p_service_id: COLOUR,
      p_staff_id: RUI,
      p_date: DAY,
      p_start_time: '14:00',
      p_end_time: '15:00',
      p_busy_until: '15:15', // 60 min + 15 min buffer
      p_service_name: 'Coloração',
      p_duration_minutes: 60,
      p_price_cents: 5000,
      p_guest_name: 'Bia',
      p_guest_phone: '912',
      p_guest_email: 'bia@example.test',
      p_notes: 'raiz',
      p_source: 'manual',
      p_guest_lang: 'pt',
      p_amount_due_cents: 0,
      p_currency: 'EUR',
      p_hold_minutes: 0,
    });
    expect(sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect((sendAppointmentConfirmation.mock.calls[0] as unknown[])[2]).toBe('Rui');
  });

  it('sends no email when the owner typed none', async () => {
    await go(() => actions.createManualAppointment(manual({ email: '' })));
    expect(state.rpcCalls).toHaveLength(1);
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>, string]>([
    ['no service', { serviceId: '' }, 'Escolha um serviço.'],
    ['no professional', { staffId: '' }, 'Escolha um profissional.'],
    ['impossible date', { date: '2026-11-31' }, 'É necessária uma data válida.'],
    ['bad time', { time: '25:00' }, 'É necessária uma hora válida.'],
    ['no name', { name: '  ' }, 'O nome do cliente é obrigatório.'],
    ['ends after midnight', { time: '23:30' }, 'A marcação terminaria depois da meia-noite. Escolha uma hora mais cedo.'],
    ['unknown service', { serviceId: 'c0000000-0000-4000-8000-0000000000ff' }, 'Escolha um serviço.'],
  ])('rejects %s in the business language without booking', async (_label, overrides, message) => {
    const to = await go(() => actions.createManualAppointment(manual(overrides)));
    expect(to).toBe(`/agenda/new?error=${message}`);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('explains a clash by naming the professional', async () => {
    state.rpc = () => ({ data: null, error: { message: 'SLOT_TAKEN' } });
    const to = await go(() => actions.createManualAppointment(manual()));
    expect(to).toBe('/agenda/new?error=Rui já tem uma marcação a essa hora.');
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
  });
});

describe('updateAppointment', () => {
  const edit = (overrides: Record<string, string> = {}) =>
    form({ serviceId: CUT, staffId: ANA, date: DAY, time: '10:00', name: 'Ada', phone: '', email: 'ada@example.test', notes: '', ...overrides });

  it('moves the appointment and keeps the snapshot when the service is unchanged', async () => {
    const appt = appointment({ price_cents: 1200, service_name: 'Corte (preço antigo)' });
    state.tables.appointments.push(appt);
    const to = await go(() => actions.updateAppointment(String(appt.id), edit({ time: '11:00', staffId: RUI, name: 'Ada L.' })));
    expect(to).toBe(`/agenda?date=${DAY}`);
    expect(appt).toMatchObject({
      staff_id: RUI,
      start_time: '11:00',
      end_time: '11:30',
      busy_until: '11:30',
      guest_name: 'Ada L.',
      price_cents: 1200,
      service_name: 'Corte (preço antigo)',
    });
  });

  it('takes a new snapshot when the service changes', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt);
    await go(() => actions.updateAppointment(String(appt.id), edit({ serviceId: COLOUR })));
    expect(appt).toMatchObject({
      service_id: COLOUR,
      service_name: 'Coloração',
      duration_minutes: 60,
      price_cents: 5000,
      end_time: '11:00',
      busy_until: '11:15',
    });
  });

  it('keeps a deleted service’s snapshot (empty service field)', async () => {
    const appt = appointment({ service_id: null, busy_until: '10:40:00' });
    state.tables.appointments.push(appt);
    await go(() => actions.updateAppointment(String(appt.id), edit({ serviceId: '', time: '12:00' })));
    expect(appt).toMatchObject({ service_id: null, service_name: 'Corte', end_time: '12:30', busy_until: '12:40' });
  });

  it('refuses a move onto another appointment of the same professional', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt, appointment({ start_time: '11:00:00', end_time: '11:30:00', busy_until: '11:30:00' }));
    const to = await go(() => actions.updateAppointment(String(appt.id), edit({ time: '11:15' })));
    expect(to).toBe(`/agenda/${appt.id}?error=Ana já tem uma marcação a essa hora.`);
    expect(appt.start_time).toBe('10:00:00');
  });

  it('does not clash with itself, with cancelled ones or with another professional', async () => {
    const appt = appointment();
    state.tables.appointments.push(
      appt,
      appointment({ start_time: '10:15:00', end_time: '10:45:00', busy_until: '10:45:00', status: 'cancelled' }),
      appointment({ staff_id: RUI, start_time: '10:15:00', end_time: '10:45:00', busy_until: '10:45:00' })
    );
    const to = await go(() => actions.updateAppointment(String(appt.id), edit({ time: '10:15' })));
    expect(to).toBe(`/agenda?date=${DAY}`);
    expect(appt.start_time).toBe('10:15');
  });

  it('an unknown appointment goes back to the list', async () => {
    const to = await go(() => actions.updateAppointment('nope', edit()));
    expect(to).toBe('/agenda/list?error=Marcação não encontrada.');
  });
});

describe('setAppointmentStatus', () => {
  it('cancelling a confirmed appointment emails the client', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt);
    const to = await go(() => actions.setAppointmentStatus(String(appt.id), 'cancelled', '/agenda/list?view=past'));
    expect(to).toBe('/agenda/list?view=past');
    expect(appt.status).toBe('cancelled');
    expect(sendAppointmentCancellation).toHaveBeenCalledTimes(1);
    expect((sendAppointmentCancellation.mock.calls[0] as unknown[])[2]).toBe('Ana');
    expect(expireSession).not.toHaveBeenCalled();
  });

  it('cancelling an unpaid hold sends no email and closes the Stripe session', async () => {
    const appt = appointment({
      status: 'pending_payment',
      payment_status: 'pending',
      stripe_session_id: 'cs_test_1',
      hold_expires_at: '2999-01-01T00:00:00Z',
    });
    state.tables.appointments.push(appt);
    state.tables.payment_accounts.push({ restaurant_id: BUSINESS, stripe_account_id: 'acct_1', charges_enabled: true });
    await go(() => actions.setAppointmentStatus(String(appt.id), 'cancelled'));
    expect(appt).toMatchObject({ status: 'cancelled', payment_status: 'none', hold_expires_at: null });
    expect(sendAppointmentCancellation).not.toHaveBeenCalled();
    expect(expireSession).toHaveBeenCalledWith('acct_1', 'cs_test_1');
  });

  it('cancelling twice emails only once', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt);
    await go(() => actions.setAppointmentStatus(String(appt.id), 'cancelled'));
    await go(() => actions.setAppointmentStatus(String(appt.id), 'cancelled'));
    expect(sendAppointmentCancellation).toHaveBeenCalledTimes(1);
  });

  it('re-confirming fails when the time has been taken meanwhile', async () => {
    const appt = appointment({ status: 'cancelled' });
    state.tables.appointments.push(appt, appointment({ guest_name: 'Outro' }));
    const to = await go(() => actions.setAppointmentStatus(String(appt.id), 'confirmed'));
    expect(to).toBe('/agenda/list?error=Ana já tem uma marcação a essa hora.');
    expect(appt.status).toBe('cancelled');
  });

  it('re-confirming a free time works and sends no email', async () => {
    const appt = appointment({ status: 'cancelled' });
    state.tables.appointments.push(appt);
    const to = await go(() => actions.setAppointmentStatus(String(appt.id), 'confirmed', `/agenda/${appt.id}`));
    expect(to).toBe(`/agenda/${appt.id}`);
    expect(appt.status).toBe('confirmed');
    expect(sendAppointmentCancellation).not.toHaveBeenCalled();
    expect(sendAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it('never redirects outside the appointments pages', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt);
    for (const back of ['https://evil.example', '//evil.example', '/settings', '/agendaX']) {
      appt.status = 'confirmed';
      expect(await go(() => actions.setAppointmentStatus(String(appt.id), 'cancelled', back))).toBe('/agenda/list');
    }
  });
});

describe('setAppointmentServiceStatus', () => {
  it('toggles on, switches, and toggles off', async () => {
    const appt = appointment();
    state.tables.appointments.push(appt);
    const id = String(appt.id);
    expect(await go(() => actions.setAppointmentServiceStatus(id, 'arrived', DAY))).toBe('');
    expect(appt.service_status).toBe('arrived');
    await go(() => actions.setAppointmentServiceStatus(id, 'completed', DAY));
    expect(appt.service_status).toBe('completed');
    await go(() => actions.setAppointmentServiceStatus(id, 'completed', DAY));
    expect(appt.service_status).toBeNull();
  });
});

// --- services ----------------------------------------------------------------

describe('saveService / deleteService', () => {
  const svc = (overrides: Record<string, string> = {}) =>
    form({ name: 'Barba', category: 'Barba', duration: '20', buffer: '5', price: '12,50', active: 'on', ...overrides });

  it('creates a service, storing the price in cents', async () => {
    const to = await go(() => actions.saveService(svc()));
    expect(to).toBe('/services?saved=1');
    expect(state.tables.services.at(-1)).toMatchObject({
      restaurant_id: BUSINESS,
      name: 'Barba',
      category: 'Barba',
      description: null,
      duration_minutes: 20,
      buffer_minutes: 5,
      price_cents: 1250,
      active: true,
    });
  });

  it('updates in place and can switch a service off', async () => {
    const fd = svc({ id: CUT, name: 'Corte clássico', price: '18' });
    fd.delete('active');
    await go(() => actions.saveService(fd));
    expect(state.tables.services).toHaveLength(2);
    expect(state.tables.services[0]).toMatchObject({ id: CUT, name: 'Corte clássico', price_cents: 1800, active: false });
  });

  it.each<[string, Record<string, string>, string]>([
    ['no name', { name: '' }, 'O nome do serviço é obrigatório.'],
    ['too short', { duration: '3' }, 'A duração tem de estar entre 5 e 480 minutos.'],
    ['too long', { duration: '500' }, 'A duração tem de estar entre 5 e 480 minutos.'],
    ['fractional duration', { duration: '20.5' }, 'A duração tem de estar entre 5 e 480 minutos.'],
    ['buffer too long', { buffer: '121' }, 'O tempo depois tem de estar entre 0 e 120 minutos.'],
    ['negative price', { price: '-1' }, 'Introduza um preço válido.'],
    ['price is not a number', { price: 'dez' }, 'Introduza um preço válido.'],
  ])('rejects %s', async (_label, overrides, message) => {
    const to = await go(() => actions.saveService(svc(overrides)));
    expect(to).toBe(`/services?error=${message}`);
    expect(state.tables.services).toHaveLength(2);
  });

  it('deletes a service', async () => {
    expect(await go(() => actions.deleteService(CUT))).toBe('/services?deleted=1');
    expect(state.tables.services.map((s) => s.id)).toEqual([COLOUR]);
  });
});

// --- team --------------------------------------------------------------------

describe('saveStaff', () => {
  it('adds an active professional following the business hours, with the ticked services', async () => {
    const to = await go(() =>
      actions.saveStaff(form({ name: 'Eva', title: 'Esteticista', color: '#4a7c4e', services: [CUT, COLOUR, 'not-mine'] }))
    );
    expect(to).toBe('/team?saved=1');
    const eva = state.tables.staff.at(-1)!;
    expect(eva).toMatchObject({ name: 'Eva', title: 'Esteticista', color: '#4a7c4e', working_hours: null, active: true });
    expect(state.tables.staff_services).toEqual([
      { staff_id: eva.id, service_id: CUT, restaurant_id: BUSINESS },
      { staff_id: eva.id, service_id: COLOUR, restaurant_id: BUSINESS },
    ]);
  });

  it('stores own hours only when switched on, and replaces the service list', async () => {
    state.tables.staff_services.push({ staff_id: ANA, service_id: CUT, restaurant_id: BUSINESS });
    const days: Record<string, string> = {};
    for (let d = 0; d < 7; d++) Object.assign(days, { [`open_${d}`]: '10:00', [`close_${d}`]: '16:00' });
    const to = await go(() =>
      actions.saveStaff(form({ id: ANA, name: 'Ana', color: '#c9954a', ownHours: 'on', closed_0: 'on', ...days, services: [COLOUR] }))
    );
    expect(to).toBe(`/team/${ANA}?saved=1`);
    const ana = state.tables.staff[0];
    expect(ana.active).toBe(false); // the switch was left off
    expect((ana.working_hours as Record<string, unknown>)['0']).toEqual({ open: '10:00', close: '16:00', closed: true });
    expect((ana.working_hours as Record<string, unknown>)['3']).toEqual({ open: '10:00', close: '16:00', closed: false });
    expect(state.tables.staff_services).toEqual([{ staff_id: ANA, service_id: COLOUR, restaurant_id: BUSINESS }]);
  });

  it('goes back to the business hours when own hours are switched off', async () => {
    state.tables.staff[0].working_hours = { '1': { open: '10:00', close: '16:00', closed: false } };
    await go(() => actions.saveStaff(form({ id: ANA, name: 'Ana', color: '#c9954a', active: 'on', open_1: '25:00' })));
    expect(state.tables.staff[0]).toMatchObject({ working_hours: null, active: true });
  });

  it.each<[string, Record<string, string>, string]>([
    ['no name', { name: '' }, 'O nome é obrigatório.'],
    ['a colour that is not hex', { color: 'red' }, 'Escolha uma cor válida.'],
    ['a day that ends before it starts', { ownHours: 'on', open_2: '18:00', close_2: '09:00' }, 'terça-feira: a hora de início tem de ser anterior à hora de fim.'],
  ])('rejects %s', async (_label, overrides, message) => {
    const to = await go(() => actions.saveStaff(form({ name: 'Eva', color: '#4a7c4e', ...overrides })));
    expect(to.toLowerCase()).toBe(`/team?error=${message}`.toLowerCase());
    expect(state.tables.staff).toHaveLength(2);
  });
});

describe('deleteStaff', () => {
  it('deletes a professional without appointments', async () => {
    expect(await go(() => actions.deleteStaff(RUI))).toBe('/team?deleted=1');
    expect(state.tables.staff.map((s) => s.id)).toEqual([ANA]);
  });

  it('deactivates instead when the foreign key refuses the delete', async () => {
    state.errors['staff.delete'] = { code: '23503', message: 'violates foreign key constraint' };
    expect(await go(() => actions.deleteStaff(RUI))).toBe('/team?deactivated=1');
    expect(state.tables.staff).toHaveLength(2);
    expect(state.tables.staff[1]).toMatchObject({ id: RUI, active: false });
  });

  it('reports any other database error', async () => {
    state.errors['staff.delete'] = { code: '42501', message: 'permission denied' };
    expect(await go(() => actions.deleteStaff(RUI))).toBe(`/team/${RUI}?error=Não foi possível guardar: permission denied`);
    expect(state.tables.staff[1].active).toBe(true);
  });
});

describe('time off', () => {
  it('adds a whole day and a timed block, and removes one', async () => {
    expect(await go(() => actions.addTimeOff(ANA, form({ date: DAY, allDay: 'on', reason: 'Férias' })))).toBe(`/team/${ANA}?saved=1`);
    await go(() => actions.addTimeOff(ANA, form({ date: DAY, start: '13:00', end: '14:00' })));
    expect(state.tables.staff_time_off).toMatchObject([
      { staff_id: ANA, restaurant_id: BUSINESS, date: DAY, start_time: null, end_time: null, reason: 'Férias' },
      { staff_id: ANA, date: DAY, start_time: '13:00', end_time: '14:00', reason: null },
    ]);
    await go(() => actions.deleteTimeOff(String(state.tables.staff_time_off[0].id), ANA));
    expect(state.tables.staff_time_off).toHaveLength(1);
  });

  it.each<[string, Record<string, string>]>([
    ['no times and not all day', { date: DAY }],
    ['end before start', { date: DAY, start: '14:00', end: '13:00' }],
  ])('rejects %s', async (_label, fields) => {
    const to = await go(() => actions.addTimeOff(ANA, form(fields)));
    expect(to).toBe(`/team/${ANA}?error=Assinale «Dia inteiro» ou indique uma hora de início anterior à hora de fim.`);
    expect(state.tables.staff_time_off).toHaveLength(0);
  });

  it('rejects an impossible date', async () => {
    const to = await go(() => actions.addTimeOff(ANA, form({ date: '2026-02-30', allDay: 'on' })));
    expect(to).toBe(`/team/${ANA}?error=É necessária uma data válida.`);
  });
});
