-- =============================================================================
-- TableFront — RLS tenant-isolation test (SQL layer)
--
-- STAGING ONLY. The runner (tests/rls/run.ts) refuses any project other than
-- tablefront-reservations-staging. You can also paste this file into the
-- STAGING project's SQL editor.
--
-- The whole file runs inside ONE transaction and ends with ROLLBACK, so the two
-- fake tenants it creates never persist. Results come back as the rows of the
-- final SELECT: one row per check, pass = true/false.
--
-- Scope (AUDIT.md section 2: "can one tenant ever read or write another
-- tenant's data?"): for each tenant-scoped table — bookings, restaurants
-- (= settings), capacity_rules (= settings), floor_zones, floor_tables,
-- floor_elements, booking_tables, owners — authenticated as owner A, try to
-- SELECT / UPDATE / DELETE / INSERT tenant B's rows, then repeat as anon.
-- =============================================================================
begin;

do $$
declare
  v_rest_a  uuid := gen_random_uuid();
  v_rest_b  uuid := gen_random_uuid();
  v_user_a  uuid := gen_random_uuid();
  v_user_b  uuid := gen_random_uuid();
  v_zone_a  uuid := gen_random_uuid();
  v_zone_b  uuid := gen_random_uuid();
  v_tbl_a   uuid := gen_random_uuid();
  v_tbl_b   uuid := gen_random_uuid();
  v_rule_a  uuid := gen_random_uuid();
  v_rule_b  uuid := gen_random_uuid();
  v_elem_b  uuid := gen_random_uuid();
  v_book_a  uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_book_b  uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_claims_a text;
  v_log     jsonb := '[]'::jsonb;
  v_n       int;
  v_cnt     int;
  v_uuid    uuid;
  v_err     text;
begin
  -- ===========================================================================
  -- Fixtures (as postgres, which bypasses RLS). Two tenants, one owner each,
  -- three bookings each, one capacity rule, one zone, one table, one
  -- booking<->table assignment each, one scenery element for B.
  -- ===========================================================================
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change, email_change_token_new)
  values
    (v_user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'rls-test-owner-a-' || left(v_user_a::text, 8) || '@example.test', now(),
     '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
    (v_user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'rls-test-owner-b-' || left(v_user_b::text, 8) || '@example.test', now(),
     '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

  insert into public.restaurants (id, name, slug, default_max_covers)
  values (v_rest_a, 'RLS Test Restaurant A', 'rls-test-a-' || left(v_rest_a::text, 8), 20),
         (v_rest_b, 'RLS Test Restaurant B', 'rls-test-b-' || left(v_rest_b::text, 8), 20);

  insert into public.owners (id, restaurant_id, email)
  values (v_user_a, v_rest_a, 'rls-test-owner-a@example.test'),
         (v_user_b, v_rest_b, 'rls-test-owner-b@example.test');

  insert into public.bookings (id, restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot, source)
  select b.id, v_rest_a, 'Guest A' || b.n, '+351000000' || b.n, 'guest-a' || b.n || '@example.test', 2, current_date + 7, '19:00', 'manual'
    from unnest(v_book_a) with ordinality as b(id, n);
  insert into public.bookings (id, restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot, source)
  select b.id, v_rest_b, 'Guest B' || b.n, '+351111111' || b.n, 'guest-b' || b.n || '@example.test', 2, current_date + 7, '19:00', 'manual'
    from unnest(v_book_b) with ordinality as b(id, n);

  insert into public.capacity_rules (id, restaurant_id, day_of_week, max_covers)
  values (v_rule_a, v_rest_a, 5, 30), (v_rule_b, v_rest_b, 5, 30);

  insert into public.floor_zones (id, restaurant_id, name)
  values (v_zone_a, v_rest_a, 'Zone A'), (v_zone_b, v_rest_b, 'Zone B');

  insert into public.floor_tables (id, restaurant_id, zone_id, name, seats, x, y, w, h)
  values (v_tbl_a, v_rest_a, v_zone_a, 'T1-A', 4, 10, 10, 80, 80),
         (v_tbl_b, v_rest_b, v_zone_b, 'T1-B', 4, 10, 10, 80, 80);

  insert into public.floor_elements (id, restaurant_id, zone_id, kind, label, x, y, w, h)
  values (v_elem_b, v_rest_b, v_zone_b, 'label', 'Bar B', 0, 0, 100, 20);

  insert into public.booking_tables (booking_id, table_id, restaurant_id)
  values (v_book_a[1], v_tbl_a, v_rest_a), (v_book_b[1], v_tbl_b, v_rest_b);

  -- ===========================================================================
  -- Act as owner A (role authenticated + JWT claims sub = user A)
  -- ===========================================================================
  v_claims_a := json_build_object('sub', v_user_a, 'role', 'authenticated', 'aud', 'authenticated')::text;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', v_claims_a, true);

  -- ---- positive controls: the harness really is running as owner A ---------
  select public.my_restaurant_id() into v_uuid;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','(rpc)','action','my_restaurant_id() resolves to A','expected',v_rest_a::text,'actual',coalesce(v_uuid::text,'null'),'pass', v_uuid = v_rest_a);

  select count(*) into v_cnt from public.bookings where restaurant_id = v_rest_a;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','select own rows (control)','expected','3 rows','actual',v_cnt||' rows','pass', v_cnt = 3);

  select count(*) into v_cnt from public.restaurants where id = v_rest_a;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','select own row (control)','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);

  update public.bookings set notes = 'edited by A' where id = v_book_a[2];
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','update own row (control)','expected','1 row','actual',v_n||' rows','pass', v_n = 1);

  -- ---- bookings -------------------------------------------------------------
  select count(*) into v_cnt from public.bookings where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','select B by restaurant_id','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  select count(*) into v_cnt from public.bookings where id = any(v_book_b);
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','select B by primary key','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.bookings set guest_name = 'RLS-HACKED' where restaurant_id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','update B rows','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  update public.bookings set status = 'cancelled' where id = v_book_b[1];
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','cancel B booking by id','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.bookings where restaurant_id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','delete B rows','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.bookings (restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot)
    values (v_rest_b, 'RLS-HACKED', '0', 'x@example.test', 2, current_date + 8, '20:00');
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','insert row for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','insert row for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','insert row for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  begin
    update public.bookings set restaurant_id = v_rest_b where id = v_book_a[1];
    get diagnostics v_n = row_count;
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','move own row into tenant B','expected','42501 rls violation','actual','UPDATED '||v_n||' rows','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','move own row into tenant B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','bookings','action','move own row into tenant B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  begin
    perform public.create_widget_booking(v_rest_b, current_date + 8, '20:00'::time, 2, 'RLS-HACKED', '0', 'x@example.test', null, 100, 'en');
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','(rpc)','action','create_widget_booking for B','expected','42501 permission denied','actual','EXECUTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','(rpc)','action','create_widget_booking for B','expected','42501 permission denied','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','(rpc)','action','create_widget_booking for B','expected','42501 permission denied','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ---- restaurants (= settings page) ----------------------------------------
  select count(*) into v_cnt from public.restaurants where id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','select B settings','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  select count(*) into v_cnt from public.restaurants;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','select all restaurants','expected','1 row (own)','actual',v_cnt||' rows','pass', v_cnt = 1);

  update public.restaurants set name = 'RLS-HACKED', default_max_covers = 0 where id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','update B settings','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.restaurants where id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','delete B restaurant','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.restaurants (name, slug) values ('RLS-HACKED', 'rls-hacked-' || left(gen_random_uuid()::text, 8));
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','insert new restaurant','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','insert new restaurant','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','restaurants','action','insert new restaurant','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ---- owners (membership) --------------------------------------------------
  select count(*) into v_cnt from public.owners where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','owners','action','select B owners','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.owners set restaurant_id = v_rest_b where id = v_user_a;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','owners','action','re-point own membership to B','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.owners (id, restaurant_id, email) values (v_user_a, v_rest_b, 'dup@example.test');
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','owners','action','insert membership for B','expected','error','actual','INSERTED','pass', false);
  exception when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','owners','action','insert membership for B','expected','error','actual',sqlstate,'pass', true);
  end;

  -- ---- capacity_rules (= settings page) -------------------------------------
  select count(*) into v_cnt from public.capacity_rules where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','select B rules','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.capacity_rules set max_covers = 999 where restaurant_id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','update B rules','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.capacity_rules where id = v_rule_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','delete B rule','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.capacity_rules (restaurant_id, day_of_week, max_covers) values (v_rest_b, 6, 999);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','insert rule for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','insert rule for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','capacity_rules','action','insert rule for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ---- floor_zones ----------------------------------------------------------
  select count(*) into v_cnt from public.floor_zones where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','select B zones','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.floor_zones set name = 'RLS-HACKED' where id = v_zone_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','update B zone','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.floor_zones where id = v_zone_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','delete B zone','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.floor_zones (restaurant_id, name) values (v_rest_b, 'RLS-HACKED');
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','insert zone for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','insert zone for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_zones','action','insert zone for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ---- floor_tables ---------------------------------------------------------
  select count(*) into v_cnt from public.floor_tables where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','select B tables','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  select count(*) into v_cnt from public.floor_tables where id = v_tbl_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','select B table by primary key','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.floor_tables set name = 'RLS-HACKED', seats = 1 where restaurant_id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','update B tables','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.floor_tables where id = v_tbl_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','delete B table','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.floor_tables (restaurant_id, zone_id, name, seats, x, y, w, h) values (v_rest_b, v_zone_b, 'RLS-HACKED', 2, 0, 0, 10, 10);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','insert table for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','insert table for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','insert table for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- cross-reference: a table owned by A but placed in B's zone
  begin
    insert into public.floor_tables (restaurant_id, zone_id, name, seats, x, y, w, h) values (v_rest_a, v_zone_b, 'RLS-HACKED', 2, 0, 0, 10, 10);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','insert own table into B zone (zone_id = B)','expected','error','actual','INSERTED','pass', false);
  exception when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_tables','action','insert own table into B zone (zone_id = B)','expected','error','actual',sqlstate,'pass', true);
  end;

  -- ---- floor_elements -------------------------------------------------------
  select count(*) into v_cnt from public.floor_elements where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','select B elements','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.floor_elements set label = 'RLS-HACKED' where id = v_elem_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','update B element','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.floor_elements where id = v_elem_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','delete B element','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.floor_elements (restaurant_id, zone_id, kind, x, y, w, h) values (v_rest_b, v_zone_b, 'wall', 0, 0, 10, 10);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','insert element for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','insert element for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','floor_elements','action','insert element for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ---- booking_tables (booking <-> table assignments) -----------------------
  select count(*) into v_cnt from public.booking_tables where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','select B assignments','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  delete from public.booking_tables where restaurant_id = v_rest_b;
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','delete B assignments','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.booking_tables (booking_id, table_id, restaurant_id) values (v_book_b[2], v_tbl_b, v_rest_b);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','insert assignment for B','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','insert assignment for B','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','insert assignment for B','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- cross-reference: seat A's booking at B's table (row tagged as tenant A)
  begin
    insert into public.booking_tables (booking_id, table_id, restaurant_id) values (v_book_a[2], v_tbl_b, v_rest_a);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','assign own booking to B table (table_id = B)','expected','error','actual','INSERTED','pass', false);
  exception when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','assign own booking to B table (table_id = B)','expected','error','actual',sqlstate,'pass', true);
  end;

  -- cross-reference: seat B's booking at A's table (row tagged as tenant A)
  begin
    insert into public.booking_tables (booking_id, table_id, restaurant_id) values (v_book_b[3], v_tbl_a, v_rest_a);
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','assign B booking to own table (booking_id = B)','expected','error','actual','INSERTED','pass', false);
  exception when others then
    v_log := v_log || jsonb_build_object('actor','owner A','tbl','booking_tables','action','assign B booking to own table (booking_id = B)','expected','error','actual',sqlstate,'pass', true);
  end;

  -- ===========================================================================
  -- Act as anonymous (role anon, no JWT subject)
  -- ===========================================================================
  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  select count(*) into v_cnt from public.bookings;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.restaurants;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.owners;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','owners','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.capacity_rules;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','capacity_rules','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.floor_zones;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_zones','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.floor_tables;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.floor_elements;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_elements','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.booking_tables;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','booking_tables','action','select any','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);

  update public.bookings set guest_name = 'RLS-HACKED' where restaurant_id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','update any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);
  update public.restaurants set name = 'RLS-HACKED' where id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','update any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);
  update public.floor_tables set name = 'RLS-HACKED' where restaurant_id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','update any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  delete from public.bookings where restaurant_id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','delete any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);
  delete from public.restaurants where id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','delete any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);
  delete from public.floor_tables where restaurant_id in (v_rest_a, v_rest_b);
  get diagnostics v_n = row_count;
  v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','delete any','expected','0 rows','actual',v_n||' rows','pass', v_n = 0);

  begin
    insert into public.bookings (restaurant_id, guest_name, guest_phone, guest_email, party_size, date, time_slot)
    values (v_rest_b, 'RLS-HACKED', '0', 'x@example.test', 2, current_date + 8, '20:00');
    v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','insert','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','insert','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','bookings','action','insert','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;
  begin
    insert into public.restaurants (name, slug) values ('RLS-HACKED', 'rls-hacked-anon-' || left(gen_random_uuid()::text, 8));
    v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','insert','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','insert','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','restaurants','action','insert','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;
  begin
    insert into public.floor_tables (restaurant_id, zone_id, name, seats, x, y, w, h) values (v_rest_b, v_zone_b, 'RLS-HACKED', 2, 0, 0, 10, 10);
    v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','insert','expected','42501 rls violation','actual','INSERTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','insert','expected','42501 rls violation','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','floor_tables','action','insert','expected','42501 rls violation','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;
  -- my_restaurant_id() is referenced by every RLS policy, so anon must be able to
  -- evaluate it; without a JWT it must resolve to null (or be denied outright).
  begin
    select public.my_restaurant_id() into v_uuid;
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call my_restaurant_id()','expected','null or 42501','actual',coalesce(v_uuid::text,'null'),'pass', v_uuid is null);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call my_restaurant_id()','expected','null or 42501','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call my_restaurant_id()','expected','null or 42501','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;
  begin
    perform public.create_widget_booking(v_rest_b, current_date + 8, '20:00'::time, 2, 'RLS-HACKED', '0', 'x@example.test', null, 100, 'en');
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call create_widget_booking()','expected','42501 permission denied','actual','EXECUTED','pass', false);
  exception when insufficient_privilege then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call create_widget_booking()','expected','42501 permission denied','actual',sqlstate,'pass', true);
  when others then
    v_log := v_log || jsonb_build_object('actor','anon','tbl','(rpc)','action','call create_widget_booking()','expected','42501 permission denied','actual','unexpected '||sqlstate||' '||sqlerrm,'pass', false);
  end;

  -- ===========================================================================
  -- Back to postgres: verify from outside RLS that nothing of B's changed and
  -- nothing was written on B's behalf.
  -- ===========================================================================
  execute 'reset role';

  select count(*) into v_cnt from public.bookings where restaurant_id = v_rest_b and status = 'confirmed' and guest_name like 'Guest B%';
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','bookings','action','verify B bookings intact','expected','3 rows','actual',v_cnt||' rows','pass', v_cnt = 3);
  select count(*) into v_cnt from public.bookings where restaurant_id = v_rest_b;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','bookings','action','verify no rows added to B','expected','3 rows','actual',v_cnt||' rows','pass', v_cnt = 3);
  select count(*) into v_cnt from public.bookings where restaurant_id = v_rest_a;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','bookings','action','verify A rows not moved','expected','3 rows','actual',v_cnt||' rows','pass', v_cnt = 3);
  select count(*) into v_cnt from public.restaurants where id = v_rest_b and name = 'RLS Test Restaurant B' and default_max_covers = 20;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','restaurants','action','verify B settings intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.restaurants where name = 'RLS-HACKED';
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','restaurants','action','verify no restaurant inserted','expected','0 rows','actual',v_cnt||' rows','pass', v_cnt = 0);
  select count(*) into v_cnt from public.owners where id = v_user_a and restaurant_id = v_rest_a;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','owners','action','verify A membership intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.capacity_rules where restaurant_id = v_rest_b and max_covers = 30;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','capacity_rules','action','verify B rules intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.floor_zones where restaurant_id = v_rest_b and name = 'Zone B';
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','floor_zones','action','verify B zones intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.floor_tables where restaurant_id = v_rest_b and name = 'T1-B' and seats = 4;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','floor_tables','action','verify B tables intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.floor_tables where zone_id = v_zone_b;
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','floor_tables','action','verify nothing placed in B zone','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.floor_elements where restaurant_id = v_rest_b and label = 'Bar B';
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','floor_elements','action','verify B elements intact','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);
  select count(*) into v_cnt from public.booking_tables where table_id = v_tbl_b or booking_id = any(v_book_b);
  v_log := v_log || jsonb_build_object('actor','postgres','tbl','booking_tables','action','verify only B own assignment references B objects','expected','1 row','actual',v_cnt||' rows','pass', v_cnt = 1);

  -- Hand the results to the final SELECT via a transaction-local setting.
  perform set_config('rls_test.results', v_log::text, true);
end $$;

select
  (row_number() over ())::int as id,
  r.actor, r.tbl, r.action, r.expected, r.actual, r.pass
from jsonb_to_recordset(current_setting('rls_test.results', true)::jsonb)
  as r(actor text, tbl text, action text, expected text, actual text, pass boolean);

rollback;
