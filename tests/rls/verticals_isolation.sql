-- =============================================================================
-- TableFront — RLS tenant-isolation test for the stays and appointments
-- products (migration 0006). Same contract as tenant_isolation.sql:
--
-- STAGING ONLY. One transaction, ends with ROLLBACK, results are the rows of
-- the final SELECT (one row per check, pass = true/false).
--
-- For every table added in 0006, as owner A and then as anon, try to read,
-- update, delete and insert tenant B's rows, move an own row into B, point an
-- own row at one of B's parents, and call the two SECURITY DEFINER booking
-- functions. Also: owners cannot write payment_accounts or change the product
-- (business_type) they are on.
-- =============================================================================
begin;

do $$
declare
  v_rest_a   uuid := gen_random_uuid();
  v_rest_b   uuid := gen_random_uuid();
  v_user_a   uuid := gen_random_uuid();
  v_user_b   uuid := gen_random_uuid();
  v_unit_a   uuid := gen_random_uuid();
  v_unit_b   uuid := gen_random_uuid();
  v_feed_a   uuid := gen_random_uuid();
  v_feed_b   uuid := gen_random_uuid();
  v_svc_a    uuid := gen_random_uuid();
  v_svc_b    uuid := gen_random_uuid();
  v_staff_a  uuid := gen_random_uuid();
  v_staff_b  uuid := gen_random_uuid();
  v_tables   text[] := array[
    'payment_accounts', 'stay_units', 'stay_rates', 'stay_ical_feeds', 'stay_reservations',
    'stay_blocks', 'services', 'staff', 'staff_services', 'staff_time_off', 'appointments'
  ];
  -- Tables an owner may write (payment_accounts is read-only for owners).
  v_writable text[] := array[
    'stay_units', 'stay_rates', 'stay_ical_feeds', 'stay_reservations',
    'stay_blocks', 'services', 'staff', 'staff_services', 'staff_time_off', 'appointments'
  ];
  v_inserts_b jsonb;   -- label -> INSERT of a row that belongs to tenant B
  v_cross     jsonb;   -- label -> INSERT of an A row that points at a B parent
  v_actor    text;
  v_t        text;
  v_label    text;
  v_stmt     text;
  v_log      jsonb := '[]'::jsonb;
  v_n        int;
  v_cnt      int;
  v_own      int;
begin
  -- ===========================================================================
  -- Fixtures (as postgres). Two tenants, one row in every 0006 table each.
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

  insert into public.restaurants (id, name, slug, default_max_covers, business_type)
  values (v_rest_a, 'RLS Verticals A', 'rls-test-va-' || left(v_rest_a::text, 8), 20, 'stays'),
         (v_rest_b, 'RLS Verticals B', 'rls-test-vb-' || left(v_rest_b::text, 8), 20, 'stays');

  insert into public.owners (id, restaurant_id, email)
  values (v_user_a, v_rest_a, 'rls-test-owner-a@example.test'),
         (v_user_b, v_rest_b, 'rls-test-owner-b@example.test');

  insert into public.payment_accounts (restaurant_id, stripe_account_id)
  values (v_rest_a, 'acct_rls_' || left(v_rest_a::text, 8)),
         (v_rest_b, 'acct_rls_' || left(v_rest_b::text, 8));

  insert into public.stay_units (id, restaurant_id, name, base_price_cents)
  values (v_unit_a, v_rest_a, 'Unit A', 10000), (v_unit_b, v_rest_b, 'Unit B', 10000);

  insert into public.stay_rates (restaurant_id, unit_id, start_date, end_date, price_cents)
  values (v_rest_a, v_unit_a, current_date + 30, current_date + 40, 15000),
         (v_rest_b, v_unit_b, current_date + 30, current_date + 40, 15000);

  insert into public.stay_ical_feeds (id, restaurant_id, unit_id, channel, url)
  values (v_feed_a, v_rest_a, v_unit_a, 'airbnb', 'https://example.test/a.ics'),
         (v_feed_b, v_rest_b, v_unit_b, 'airbnb', 'https://example.test/b.ics');

  insert into public.stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name, source)
  values (v_rest_a, v_unit_a, current_date + 10, current_date + 12, 'Guest A', 'manual'),
         (v_rest_b, v_unit_b, current_date + 10, current_date + 12, 'Guest B', 'manual');

  insert into public.stay_blocks (restaurant_id, unit_id, start_date, end_date)
  values (v_rest_a, v_unit_a, current_date + 50, current_date + 52),
         (v_rest_b, v_unit_b, current_date + 50, current_date + 52);

  insert into public.services (id, restaurant_id, name, duration_minutes, price_cents)
  values (v_svc_a, v_rest_a, 'Cut A', 30, 2000), (v_svc_b, v_rest_b, 'Cut B', 30, 2000);

  insert into public.staff (id, restaurant_id, name)
  values (v_staff_a, v_rest_a, 'Staff A'), (v_staff_b, v_rest_b, 'Staff B');

  insert into public.staff_services (staff_id, service_id, restaurant_id)
  values (v_staff_a, v_svc_a, v_rest_a), (v_staff_b, v_svc_b, v_rest_b);

  insert into public.staff_time_off (restaurant_id, staff_id, date)
  values (v_rest_a, v_staff_a, current_date + 20), (v_rest_b, v_staff_b, current_date + 20);

  insert into public.appointments (restaurant_id, service_id, staff_id, date, start_time, end_time, busy_until,
                                   service_name, duration_minutes, guest_name, source)
  values (v_rest_a, v_svc_a, v_staff_a, current_date + 5, '10:00', '10:30', '10:30', 'Cut A', 30, 'Guest A', 'manual'),
         (v_rest_b, v_svc_b, v_staff_b, current_date + 5, '10:00', '10:30', '10:30', 'Cut B', 30, 'Guest B', 'manual');

  -- Rows that belong to B: must be refused for anyone who is not B.
  v_inserts_b := jsonb_build_object(
    'payment_accounts',  format('insert into public.payment_accounts (restaurant_id, stripe_account_id) values (%L, %L)', gen_random_uuid(), 'acct_rls_hacked'),
    'stay_units',        format('insert into public.stay_units (restaurant_id, name) values (%L, %L)', v_rest_b, 'RLS-HACKED'),
    'stay_rates',        format('insert into public.stay_rates (restaurant_id, unit_id, start_date, end_date, price_cents) values (%L, %L, current_date + 60, current_date + 61, 1)', v_rest_b, v_unit_b),
    'stay_ical_feeds',   format('insert into public.stay_ical_feeds (restaurant_id, unit_id, channel, url) values (%L, %L, %L, %L)', v_rest_b, v_unit_b, 'other', 'https://example.test/hacked.ics'),
    'stay_reservations', format('insert into public.stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name) values (%L, %L, current_date + 70, current_date + 71, %L)', v_rest_b, v_unit_b, 'RLS-HACKED'),
    'stay_blocks',       format('insert into public.stay_blocks (restaurant_id, unit_id, start_date, end_date) values (%L, %L, current_date + 80, current_date + 81)', v_rest_b, v_unit_b),
    'services',          format('insert into public.services (restaurant_id, name, duration_minutes) values (%L, %L, 30)', v_rest_b, 'RLS-HACKED'),
    'staff',             format('insert into public.staff (restaurant_id, name) values (%L, %L)', v_rest_b, 'RLS-HACKED'),
    'staff_services',    format('insert into public.staff_services (staff_id, service_id, restaurant_id) values (%L, %L, %L)', v_staff_b, v_svc_b, v_rest_b),
    'staff_time_off',    format('insert into public.staff_time_off (restaurant_id, staff_id, date) values (%L, %L, current_date + 21)', v_rest_b, v_staff_b),
    'appointments',      format('insert into public.appointments (restaurant_id, staff_id, date, start_time, end_time, busy_until, service_name, duration_minutes, guest_name) values (%L, %L, current_date + 6, %L, %L, %L, %L, 30, %L)', v_rest_b, v_staff_b, '11:00', '11:30', '11:30', 'RLS-HACKED', 'RLS-HACKED')
  );

  -- Rows that claim to be A's but hang off one of B's parents: the composite
  -- foreign keys must refuse them even though RLS (restaurant_id = A) passes.
  v_cross := jsonb_build_object(
    'stay_rates -> B unit',        format('insert into public.stay_rates (restaurant_id, unit_id, start_date, end_date, price_cents) values (%L, %L, current_date + 60, current_date + 61, 1)', v_rest_a, v_unit_b),
    'stay_ical_feeds -> B unit',   format('insert into public.stay_ical_feeds (restaurant_id, unit_id, channel, url) values (%L, %L, %L, %L)', v_rest_a, v_unit_b, 'other', 'https://example.test/cross.ics'),
    'stay_reservations -> B unit', format('insert into public.stay_reservations (restaurant_id, unit_id, check_in, check_out, guest_name) values (%L, %L, current_date + 70, current_date + 71, %L)', v_rest_a, v_unit_b, 'RLS-HACKED'),
    'stay_reservations -> B feed', format('insert into public.stay_reservations (restaurant_id, unit_id, feed_id, external_uid, check_in, check_out, guest_name, source) values (%L, %L, %L, %L, current_date + 72, current_date + 73, %L, %L)', v_rest_a, v_unit_a, v_feed_b, 'cross', 'RLS-HACKED', 'airbnb'),
    'stay_blocks -> B unit',       format('insert into public.stay_blocks (restaurant_id, unit_id, start_date, end_date) values (%L, %L, current_date + 80, current_date + 81)', v_rest_a, v_unit_b),
    'staff_services -> B staff',   format('insert into public.staff_services (staff_id, service_id, restaurant_id) values (%L, %L, %L)', v_staff_b, v_svc_a, v_rest_a),
    'staff_services -> B service', format('insert into public.staff_services (staff_id, service_id, restaurant_id) values (%L, %L, %L)', v_staff_a, v_svc_b, v_rest_a),
    'staff_time_off -> B staff',   format('insert into public.staff_time_off (restaurant_id, staff_id, date) values (%L, %L, current_date + 21)', v_rest_a, v_staff_b),
    'appointments -> B staff',     format('insert into public.appointments (restaurant_id, staff_id, date, start_time, end_time, busy_until, service_name, duration_minutes, guest_name) values (%L, %L, current_date + 6, %L, %L, %L, %L, 30, %L)', v_rest_a, v_staff_b, '12:00', '12:30', '12:30', 'RLS-HACKED', 'RLS-HACKED'),
    'appointments -> B service',   format('insert into public.appointments (restaurant_id, service_id, staff_id, date, start_time, end_time, busy_until, service_name, duration_minutes, guest_name) values (%L, %L, %L, current_date + 6, %L, %L, %L, %L, 30, %L)', v_rest_a, v_svc_b, v_staff_a, '13:00', '13:30', '13:30', 'RLS-HACKED', 'RLS-HACKED')
  );

  -- ===========================================================================
  -- Owner A, then anon.
  -- ===========================================================================
  foreach v_actor in array array['owner A', 'anon'] loop
    execute 'reset role';
    if v_actor = 'owner A' then
      execute 'set local role authenticated';
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_user_a, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
      v_own := 1;
    else
      execute 'set local role anon';
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      v_own := 0;
    end if;

    foreach v_t in array v_tables loop
      execute format('select count(*) from public.%I where restaurant_id = %L', v_t, v_rest_a) into v_cnt;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action',
        case when v_own = 1 then 'select own rows (control)' else 'select A rows' end,
        'expected', v_own || ' rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = v_own);

      execute format('select count(*) from public.%I where restaurant_id = %L', v_t, v_rest_b) into v_cnt;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'select B rows',
        'expected', '0 rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = 0);

      execute format('select count(*) from public.%I', v_t) into v_cnt;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'select without a filter',
        'expected', v_own || ' rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = v_own);

      execute format('update public.%I set restaurant_id = restaurant_id where restaurant_id = %L', v_t, v_rest_b);
      get diagnostics v_n = row_count;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'update B rows',
        'expected', '0 rows', 'actual', v_n || ' rows', 'pass', v_n = 0);

      execute format('delete from public.%I where restaurant_id = %L', v_t, v_rest_b);
      get diagnostics v_n = row_count;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'delete B rows',
        'expected', '0 rows', 'actual', v_n || ' rows', 'pass', v_n = 0);

      -- Insert a row that belongs to B.
      begin
        execute v_inserts_b ->> v_t;
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'insert row for B',
          'expected', '42501 rls violation', 'actual', 'INSERTED', 'pass', false);
      exception when insufficient_privilege then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'insert row for B',
          'expected', '42501 rls violation', 'actual', sqlstate, 'pass', true);
      when others then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'insert row for B',
          'expected', '42501 rls violation', 'actual', 'unexpected ' || sqlstate || ' ' || sqlerrm, 'pass', false);
      end;
    end loop;

    -- Move an own row into B (owner A), or any row at all (anon sees none).
    foreach v_t in array v_writable loop
      begin
        execute format('update public.%I set restaurant_id = %L where restaurant_id = %L', v_t, v_rest_b, v_rest_a);
        get diagnostics v_n = row_count;
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'move A row into B',
          'expected', 'refused', 'actual', v_n || ' rows', 'pass', v_n = 0);
      exception when insufficient_privilege or foreign_key_violation then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'move A row into B',
          'expected', 'refused', 'actual', sqlstate, 'pass', true);
      when others then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', v_t, 'action', 'move A row into B',
          'expected', 'refused', 'actual', 'unexpected ' || sqlstate || ' ' || sqlerrm, 'pass', false);
      end;
    end loop;

    -- An A row that points at a B parent.
    for v_label, v_stmt in select key, value from jsonb_each_text(v_cross) loop
      begin
        execute v_stmt;
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', split_part(v_label, ' ', 1), 'action', 'insert A row: ' || v_label,
          'expected', 'refused', 'actual', 'INSERTED', 'pass', false);
      exception when insufficient_privilege or foreign_key_violation then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', split_part(v_label, ' ', 1), 'action', 'insert A row: ' || v_label,
          'expected', 'refused', 'actual', sqlstate, 'pass', true);
      when others then
        v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', split_part(v_label, ' ', 1), 'action', 'insert A row: ' || v_label,
          'expected', 'refused', 'actual', 'unexpected ' || sqlstate || ' ' || sqlerrm, 'pass', false);
      end;
    end loop;

    -- payment_accounts is read-only for owners, invisible to anon.
    begin
      execute format('insert into public.payment_accounts (restaurant_id, stripe_account_id) values (%L, %L)', v_rest_a, 'acct_rls_own');
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'payment_accounts', 'action', 'insert a row for A',
        'expected', 'refused', 'actual', 'INSERTED', 'pass', false);
    exception when insufficient_privilege or unique_violation then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'payment_accounts', 'action', 'insert a row for A',
        'expected', 'refused', 'actual', sqlstate, 'pass', sqlstate = '42501');
    end;
    update public.payment_accounts set charges_enabled = true, stripe_account_id = 'acct_rls_hacked' where restaurant_id = v_rest_a;
    get diagnostics v_n = row_count;
    v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'payment_accounts', 'action', 'update A row',
      'expected', '0 rows', 'actual', v_n || ' rows', 'pass', v_n = 0);
    delete from public.payment_accounts where restaurant_id = v_rest_a;
    get diagnostics v_n = row_count;
    v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'payment_accounts', 'action', 'delete A row',
      'expected', '0 rows', 'actual', v_n || ' rows', 'pass', v_n = 0);

    -- The product a business is on is set by TableFront, never by the owner.
    begin
      update public.restaurants set business_type = 'appointments' where id = v_rest_a;
      get diagnostics v_n = row_count;
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'restaurants', 'action', 'change own business_type',
        'expected', 'refused', 'actual', v_n || ' rows', 'pass', v_n = 0);
    exception when insufficient_privilege then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', 'restaurants', 'action', 'change own business_type',
        'expected', 'refused', 'actual', sqlstate, 'pass', true);
    end;

    -- SECURITY DEFINER booking functions: service role only.
    begin
      perform public.create_stay_reservation(v_rest_b, v_unit_b, current_date + 90, current_date + 91, 1,
        'RLS-HACKED', '0', 'x@example.test', null, 'widget', 'en', 0, 0, 'EUR', 0);
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_stay_reservation()',
        'expected', '42501 permission denied', 'actual', 'EXECUTED', 'pass', false);
    exception when insufficient_privilege then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_stay_reservation()',
        'expected', '42501 permission denied', 'actual', sqlstate, 'pass', true);
    when others then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_stay_reservation()',
        'expected', '42501 permission denied', 'actual', 'unexpected ' || sqlstate || ' ' || sqlerrm, 'pass', false);
    end;
    begin
      perform public.create_appointment(v_rest_b, v_svc_b, v_staff_b, current_date + 7, '15:00'::time, '15:30'::time, '15:30'::time,
        'RLS-HACKED', 30, 0, 'RLS-HACKED', '0', 'x@example.test', null, 'widget', 'en', 0, 'EUR', 0);
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_appointment()',
        'expected', '42501 permission denied', 'actual', 'EXECUTED', 'pass', false);
    exception when insufficient_privilege then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_appointment()',
        'expected', '42501 permission denied', 'actual', sqlstate, 'pass', true);
    when others then
      v_log := v_log || jsonb_build_object('actor', v_actor, 'tbl', '(rpc)', 'action', 'call create_appointment()',
        'expected', '42501 permission denied', 'actual', 'unexpected ' || sqlstate || ' ' || sqlerrm, 'pass', false);
    end;
  end loop;

  -- ===========================================================================
  -- Back to postgres: nothing of A's or B's changed, nothing was added.
  -- ===========================================================================
  execute 'reset role';

  foreach v_t in array v_tables loop
    execute format('select count(*) from public.%I where restaurant_id = %L', v_t, v_rest_b) into v_cnt;
    v_log := v_log || jsonb_build_object('actor', 'postgres', 'tbl', v_t, 'action', 'verify B rows intact',
      'expected', '1 rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = 1);
    execute format('select count(*) from public.%I where restaurant_id = %L', v_t, v_rest_a) into v_cnt;
    v_log := v_log || jsonb_build_object('actor', 'postgres', 'tbl', v_t, 'action', 'verify A rows intact',
      'expected', '1 rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = 1);
  end loop;

  select count(*) into v_cnt from public.payment_accounts
   where restaurant_id = v_rest_a and not charges_enabled and stripe_account_id = 'acct_rls_' || left(v_rest_a::text, 8);
  v_log := v_log || jsonb_build_object('actor', 'postgres', 'tbl', 'payment_accounts', 'action', 'verify A account unchanged',
    'expected', '1 rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = 1);
  select count(*) into v_cnt from public.restaurants where id = v_rest_a and business_type = 'stays';
  v_log := v_log || jsonb_build_object('actor', 'postgres', 'tbl', 'restaurants', 'action', 'verify A business_type unchanged',
    'expected', '1 rows', 'actual', v_cnt || ' rows', 'pass', v_cnt = 1);

  perform set_config('rls_test.results', v_log::text, true);
end $$;

select
  (row_number() over ())::int as id,
  r.actor, r.tbl, r.action, r.expected, r.actual, r.pass
from jsonb_to_recordset(current_setting('rls_test.results', true)::jsonb)
  as r(actor text, tbl text, action text, expected text, actual text, pass boolean);

rollback;
