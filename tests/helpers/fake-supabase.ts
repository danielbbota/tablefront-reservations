// =============================================================================
// In-memory stand-in for the Supabase client, for hermetic unit tests of the
// booking flow (tests/unit/booking-flow.test.ts).
//
// It implements just the PostgREST query-builder surface the app uses
// (from/select/insert/update/delete, eq/is/in/lt/like, limit, order, single,
// maybeSingle, returns, rpc) and mirrors the parts of the schema that matter
// for booking: column defaults, CHECK constraints, the unique indexes, the
// `time` column normalisation ("19:00" -> "19:00:00"), real-calendar date
// validation, and the body of `create_widget_booking()` exactly as written in
// supabase/migrations/0003_guest_lang_reminders_service.sql (advisory lock
// aside: a single-threaded fake needs none).
//
// Two client modes:
//   db.asAdmin()         service-role: sees and writes everything (no RLS).
//   db.asOwner(userId)   anon key + owner JWT: emulates the RLS policies from
//                        0001/0004 (rows where restaurant_id = my_restaurant_id()).
//
// Not modelled on purpose: function EXECUTE grants (AUDIT.md C1/F1 is covered
// against the real database in tests/integration/booking-flow.test.ts).
// =============================================================================
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export type PgError = { code: string; message: string; details: string | null; hint: string | null };

export type Result<T = unknown> = {
  data: T;
  error: PgError | null;
  count: number | null;
  status: number;
  statusText: string;
};

type Ctx = { role: 'admin' } | { role: 'owner'; userId: string };

const TENANT_TABLES = new Set([
  'capacity_rules',
  'bookings',
  'floor_zones',
  'floor_tables',
  'floor_elements',
  'booking_tables',
]);

const LANGS = ['en', 'pt', 'de', 'fr'];

/** True for a YYYY-MM-DD string that is a real calendar date (Postgres `date` semantics). */
export function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Postgres `time` columns come back as HH:MM:SS. */
export function normTime(value: unknown): unknown {
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  return value;
}

const isTimeLike = (v: unknown): v is string => typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v);

/** Equality the way PostgREST compares typed columns (times ignore the seconds formatting). */
function same(a: unknown, b: unknown): boolean {
  if (isTimeLike(a) && isTimeLike(b)) return normTime(a) === normTime(b);
  return a === b;
}

const pgErr = (code: string, message: string, details: string | null = null, hint: string | null = null): PgError => ({
  code,
  message,
  details,
  hint,
});

class PgThrow extends Error {
  constructor(public pg: PgError) {
    super(pg.message);
  }
}

const ok = <T>(data: T, count: number | null = null): Result<T> => ({
  data,
  error: null,
  count,
  status: 200,
  statusText: 'OK',
});

const fail = (pg: PgError): Result<null> => ({
  data: null,
  error: pg,
  count: null,
  status: pg.code === '42501' ? 403 : pg.code === 'PGRST116' ? 406 : 400,
  statusText: '',
});

function project(row: Row, columns: string): Row {
  if (columns.trim() === '*') return { ...row };
  const out: Row = {};
  for (const col of columns.split(',').map((c) => c.trim()).filter(Boolean)) out[col] = row[col];
  return out;
}

export type RpcCall = { name: string; args: Row };

export class FakeDb {
  tables: Record<string, Row[]> = {
    restaurants: [],
    owners: [],
    capacity_rules: [],
    bookings: [],
    floor_zones: [],
    floor_tables: [],
    floor_elements: [],
    booking_tables: [],
  };
  /** Every rpc() call, in order, with the exact arguments the app passed. */
  rpcCalls: RpcCall[] = [];

  asAdmin(): FakeClient {
    return new FakeClient(this, { role: 'admin' });
  }
  asOwner(userId: string): FakeClient {
    return new FakeClient(this, { role: 'owner', userId });
  }

  /** Insert a row as the service role and return it (defaults applied). Throws on constraint errors. */
  seed(table: string, row: Row): Row {
    const prepared = this.prepareInsert(table, row);
    this.checkRow(table, prepared);
    this.rows(table).push(prepared);
    return prepared;
  }

  rows(table: string): Row[] {
    const rows = this.tables[table];
    if (!rows) throw new PgThrow(pgErr('42P01', `relation "public.${table}" does not exist`));
    return rows;
  }

  restaurantOf(userId: string): string | null {
    const owner = this.tables.owners.find((o) => o.id === userId);
    return owner ? (owner.restaurant_id as string) : null;
  }

  // ---------------------------------------------------------------------------
  // Schema emulation
  // ---------------------------------------------------------------------------

  prepareInsert(table: string, input: Row): Row {
    const now = new Date().toISOString();
    const row: Row = { ...input };
    switch (table) {
      case 'restaurants':
        return {
          id: randomUUID(),
          timezone: 'Europe/Lisbon',
          slot_interval_minutes: 30,
          operating_hours: {},
          default_max_covers: 20,
          brand: {},
          language: 'en',
          turn_time_minutes: 90,
          created_at: now,
          ...row,
        };
      case 'owners':
        return { created_at: now, ...row };
      case 'capacity_rules':
        return {
          id: randomUUID(),
          day_of_week: null,
          specific_date: null,
          created_at: now,
          ...row,
          time_slot: row.time_slot == null ? null : normTime(row.time_slot),
        };
      case 'bookings':
        return {
          id: randomUUID(),
          notes: null,
          table_number: null,
          status: 'confirmed',
          source: 'widget',
          guest_lang: 'en',
          cancel_token: randomUUID(),
          reminder_sent_at: null,
          service_status: null,
          created_at: now,
          ...row,
          time_slot: normTime(row.time_slot),
        };
      case 'floor_zones':
      case 'floor_tables':
      case 'floor_elements':
        return { id: randomUUID(), created_at: now, ...row };
      default:
        return row;
    }
  }

  prepareUpdate(table: string, current: Row, patch: Row): Row {
    const next: Row = { ...current, ...patch };
    if ((table === 'bookings' || table === 'capacity_rules') && 'time_slot' in patch && patch.time_slot != null) {
      next.time_slot = normTime(patch.time_slot);
    }
    return next;
  }

  /** CHECK constraints, NOT NULLs that matter, foreign keys and unique indexes. */
  checkRow(table: string, row: Row, previous?: Row): void {
    const check = (cond: boolean, name: string) => {
      if (!cond)
        throw new PgThrow(pgErr('23514', `new row for relation "${table}" violates check constraint "${name}"`));
    };
    const fkRestaurant = () => {
      if (!this.tables.restaurants.some((r) => r.id === row.restaurant_id))
        throw new PgThrow(
          pgErr('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_restaurant_id_fkey"`)
        );
    };
    const unique = (name: string, pred: (other: Row) => boolean) => {
      if (this.rows(table).some((other) => other !== previous && other !== row && pred(other)))
        throw new PgThrow(pgErr('23505', `duplicate key value violates unique constraint "${name}"`));
    };
    const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

    switch (table) {
      case 'restaurants': {
        const r = row as { slot_interval_minutes: number; default_max_covers: number; turn_time_minutes: number; language: string; slug: string };
        check(int(r.slot_interval_minutes) && r.slot_interval_minutes >= 15 && r.slot_interval_minutes <= 120, 'restaurants_slot_interval_minutes_check');
        check(int(r.default_max_covers) && r.default_max_covers >= 0, 'restaurants_default_max_covers_check');
        check(int(r.turn_time_minutes) && r.turn_time_minutes >= 30 && r.turn_time_minutes <= 360, 'restaurants_turn_time_minutes_check');
        check(LANGS.includes(r.language), 'restaurants_language_check');
        unique('restaurants_slug_key', (o) => o.slug === r.slug);
        return;
      }
      case 'owners':
        fkRestaurant();
        unique('owners_pkey', (o) => o.id === row.id);
        return;
      case 'capacity_rules': {
        const r = row as { day_of_week: number | null; specific_date: string | null; time_slot: string | null; max_covers: number };
        fkRestaurant();
        check(r.day_of_week == null || (int(r.day_of_week) && r.day_of_week >= 0 && r.day_of_week <= 6), 'capacity_rules_day_of_week_check');
        check(int(r.max_covers) && r.max_covers >= 0, 'capacity_rules_max_covers_check');
        check(r.day_of_week != null || r.specific_date != null, 'capacity_rules_check');
        if (r.specific_date != null && !isRealDate(r.specific_date))
          throw new PgThrow(pgErr('22008', `date/time field value out of range: "${r.specific_date}"`));
        unique(
          'capacity_rules_unique_scope',
          (o) =>
            o.restaurant_id === row.restaurant_id &&
            (o.day_of_week ?? -1) === (r.day_of_week ?? -1) &&
            (o.specific_date ?? 'epoch') === (r.specific_date ?? 'epoch') &&
            (o.time_slot ?? '00:00:00') === (r.time_slot ?? '00:00:00')
        );
        return;
      }
      case 'bookings': {
        const r = row as { party_size: number; date: string; time_slot: string; status: string; source: string; guest_lang: string; service_status: string | null; cancel_token: string; guest_name: unknown; guest_phone: unknown; guest_email: unknown };
        fkRestaurant();
        for (const col of ['guest_name', 'guest_phone', 'guest_email'] as const) {
          if (r[col] == null)
            throw new PgThrow(pgErr('23502', `null value in column "${col}" of relation "bookings" violates not-null constraint`));
        }
        if (!isRealDate(r.date)) throw new PgThrow(pgErr('22008', `date/time field value out of range: "${r.date}"`));
        if (!isTimeLike(r.time_slot)) throw new PgThrow(pgErr('22007', `invalid input syntax for type time: "${r.time_slot}"`));
        check(int(r.party_size) && r.party_size >= 1 && r.party_size <= 50, 'bookings_party_size_check');
        check(['confirmed', 'cancelled'].includes(r.status), 'bookings_status_check');
        check(['widget', 'manual'].includes(r.source), 'bookings_source_check');
        check(LANGS.includes(r.guest_lang), 'bookings_guest_lang_check');
        check(r.service_status == null || ['arrived', 'seated', 'no_show'].includes(r.service_status), 'bookings_service_status_check');
        unique('bookings_cancel_token_idx', (o) => o.cancel_token === r.cancel_token);
        return;
      }
      case 'booking_tables':
        fkRestaurant();
        return;
      default:
        return;
    }
  }

  /** ON DELETE CASCADE for the paths tests can hit. */
  cascade(table: string, deleted: Row[]): void {
    if (table === 'restaurants') {
      const ids = new Set(deleted.map((r) => r.id));
      for (const t of ['owners', ...TENANT_TABLES]) {
        this.tables[t] = this.tables[t].filter((r) => !ids.has(r.restaurant_id));
      }
    }
    if (table === 'bookings') {
      const ids = new Set(deleted.map((r) => r.id));
      this.tables.booking_tables = this.tables.booking_tables.filter((r) => !ids.has(r.booking_id));
    }
  }

  // ---------------------------------------------------------------------------
  // Postgres functions
  // ---------------------------------------------------------------------------

  callRpc(name: string, args: Row): Result {
    try {
      if (name === 'create_widget_booking') return ok(this.createWidgetBooking(args));
      if (name === 'my_restaurant_id') return ok(null);
      throw new PgThrow(pgErr('PGRST202', `Could not find the function public.${name} in the schema cache`));
    } catch (e) {
      if (e instanceof PgThrow) return fail(e.pg);
      throw e;
    }
  }

  /**
   * Mirror of public.create_widget_booking(...) from migration 0003:
   * lock per restaurant+date+slot, sum confirmed covers for that EXACT slot,
   * raise SLOT_FULL when the party would exceed the caller-supplied cap,
   * otherwise insert a confirmed widget booking and return the row.
   */
  private createWidgetBooking(a: Row): Row {
    const restaurantId = a.p_restaurant_id as string;
    const date = a.p_date;
    const slot = normTime(a.p_time_slot) as string;
    const party = a.p_party_size as number;
    const cap = a.p_max_covers as number;
    if (!isRealDate(date)) throw new PgThrow(pgErr('22008', `date/time field value out of range: "${String(date)}"`));
    if (!isTimeLike(slot)) throw new PgThrow(pgErr('22007', `invalid input syntax for type time: "${String(a.p_time_slot)}"`));

    const booked = this.tables.bookings
      .filter((b) => b.restaurant_id === restaurantId && b.date === date && b.time_slot === slot && b.status === 'confirmed')
      .reduce((sum, b) => sum + (b.party_size as number), 0);
    if (booked + party > cap) throw new PgThrow(pgErr('P0001', 'SLOT_FULL'));

    const lang = a.p_guest_lang;
    const row = this.prepareInsert('bookings', {
      restaurant_id: restaurantId,
      guest_name: a.p_guest_name,
      guest_phone: a.p_guest_phone,
      guest_email: a.p_guest_email,
      party_size: party,
      date,
      time_slot: slot,
      notes: a.p_notes ?? null,
      status: 'confirmed',
      source: 'widget',
      guest_lang: typeof lang === 'string' && LANGS.includes(lang) ? lang : 'en',
    });
    this.checkRow('bookings', row);
    this.tables.bookings.push(row);
    return { ...row };
  }
}

// -----------------------------------------------------------------------------
// Client + query builder
// -----------------------------------------------------------------------------

export class FakeClient {
  constructor(
    private db: FakeDb,
    private ctx: Ctx
  ) {}

  from(table: string): FakeQuery {
    return new FakeQuery(this.db, this.ctx, table);
  }

  rpc(name: string, args: Row = {}): FakeRpc {
    this.db.rpcCalls.push({ name, args: { ...args } });
    return new FakeRpc(this.db.callRpc(name, args));
  }
}

type Op = 'select' | 'insert' | 'update' | 'delete';
type Mode = 'many' | 'single' | 'maybeSingle';

export class FakeQuery implements PromiseLike<Result> {
  private op: Op = 'select';
  private columns = '*';
  private payload: Row | Row[] | null = null;
  private filters: ((row: Row) => boolean)[] = [];
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private mode: Mode = 'many';
  private wantRows = false;
  private countExact = false;
  private head = false;

  constructor(
    private db: FakeDb,
    private ctx: Ctx,
    private table: string
  ) {}

  select(columns = '*', opts: { count?: 'exact'; head?: boolean } = {}): this {
    if (this.op !== 'select') this.wantRows = true;
    this.columns = columns;
    if (opts.count === 'exact') this.countExact = true;
    if (opts.head) this.head = true;
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((r) => same(r[column], value));
    return this;
  }
  neq(column: string, value: unknown): this {
    this.filters.push((r) => !same(r[column], value));
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((r) => values.some((v) => same(r[column], v)));
    return this;
  }
  is(column: string, value: null | boolean): this {
    this.filters.push((r) => (value === null ? r[column] == null : r[column] === value));
    return this;
  }
  lt(column: string, value: unknown): this {
    this.filters.push((r) => (r[column] as never) < (value as never));
    return this;
  }
  lte(column: string, value: unknown): this {
    this.filters.push((r) => (r[column] as never) <= (value as never));
    return this;
  }
  gt(column: string, value: unknown): this {
    this.filters.push((r) => (r[column] as never) > (value as never));
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push((r) => (r[column] as never) >= (value as never));
    return this;
  }
  like(column: string, pattern: string): this {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`);
    this.filters.push((r) => typeof r[column] === 'string' && re.test(r[column] as string));
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}): this {
    this.orderBy = { column, ascending: opts.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  returns<T = unknown>(): FakeQuery & PromiseLike<Result<T>> {
    return this as FakeQuery & PromiseLike<Result<T>>;
  }
  single<T = unknown>(): FakeQuery & PromiseLike<Result<T>> {
    this.mode = 'single';
    return this as FakeQuery & PromiseLike<Result<T>>;
  }
  maybeSingle<T = unknown>(): FakeQuery & PromiseLike<Result<T>> {
    this.mode = 'maybeSingle';
    return this as FakeQuery & PromiseLike<Result<T>>;
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.exec()).then(onfulfilled, onrejected);
  }

  // --- RLS emulation ---------------------------------------------------------

  private visible(row: Row): boolean {
    if (this.ctx.role === 'admin') return true;
    const rid = this.db.restaurantOf(this.ctx.userId);
    if (this.table === 'owners') return row.id === this.ctx.userId;
    if (this.table === 'restaurants') return rid !== null && row.id === rid;
    if (TENANT_TABLES.has(this.table)) return rid !== null && row.restaurant_id === rid;
    return false;
  }

  private withCheck(row: Row): boolean {
    if (this.ctx.role === 'admin') return true;
    const rid = this.db.restaurantOf(this.ctx.userId);
    if (this.table === 'owners') return false; // SELECT-only policy
    if (this.table === 'restaurants') return this.op === 'update' && rid !== null && row.id === rid; // no INSERT policy
    if (TENANT_TABLES.has(this.table)) return rid !== null && row.restaurant_id === rid;
    return false;
  }

  // --- execution -------------------------------------------------------------

  private exec(): Result {
    try {
      const rows = this.db.rows(this.table);
      const matches = (r: Row) => this.visible(r) && this.filters.every((f) => f(r));
      let out: Row[] = [];

      switch (this.op) {
        case 'select':
          out = rows.filter(matches);
          break;
        case 'insert': {
          const list = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
          const prepared = list.map((p) => this.db.prepareInsert(this.table, p));
          for (const row of prepared) {
            if (!this.withCheck(row))
              throw new PgThrow(pgErr('42501', `new row violates row-level security policy for table "${this.table}"`));
            this.db.checkRow(this.table, row);
          }
          rows.push(...prepared);
          out = prepared;
          break;
        }
        case 'update': {
          const targets = rows.filter(matches);
          const next = targets.map((t) => this.db.prepareUpdate(this.table, t, (this.payload as Row) ?? {}));
          next.forEach((n, i) => {
            if (!this.withCheck(n))
              throw new PgThrow(pgErr('42501', `new row violates row-level security policy for table "${this.table}"`));
            this.db.checkRow(this.table, n, targets[i]);
          });
          targets.forEach((t, i) => Object.assign(t, next[i]));
          out = targets;
          break;
        }
        case 'delete': {
          const targets = rows.filter(matches);
          for (const t of targets) rows.splice(rows.indexOf(t), 1);
          this.db.cascade(this.table, targets);
          out = targets;
          break;
        }
      }

      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        out = [...out].sort((a, b) => {
          const x = a[column] as never;
          const y = b[column] as never;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (this.limitN !== null) out = out.slice(0, this.limitN);

      const count = this.countExact ? out.length : null;
      if (this.head) return ok(null, count);

      const projected = out.map((r) => project(r, this.columns));
      const returnsRows = this.op === 'select' || this.wantRows;

      if (this.mode === 'single') {
        if (projected.length !== 1)
          return fail(
            pgErr('PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${projected.length} rows`)
          );
        return ok(projected[0], count);
      }
      if (this.mode === 'maybeSingle') {
        if (projected.length > 1)
          return fail(pgErr('PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${projected.length} rows`));
        return ok(projected[0] ?? null, count);
      }
      return ok(returnsRows ? projected : null, count);
    } catch (e) {
      if (e instanceof PgThrow) return fail(e.pg);
      throw e;
    }
  }
}

export class FakeRpc implements PromiseLike<Result> {
  constructor(private result: Result) {}
  single<T = unknown>(): FakeRpc & PromiseLike<Result<T>> {
    return this as FakeRpc & PromiseLike<Result<T>>;
  }
  maybeSingle<T = unknown>(): FakeRpc & PromiseLike<Result<T>> {
    return this as FakeRpc & PromiseLike<Result<T>>;
  }
  returns<T = unknown>(): FakeRpc & PromiseLike<Result<T>> {
    return this as FakeRpc & PromiseLike<Result<T>>;
  }
  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}
