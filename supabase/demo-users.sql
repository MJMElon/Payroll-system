-- ---------------------------------------------------------------------------
-- DEMO USERS — eleven accounts to try the Team Manage chart with.
--
-- Run this in the Supabase SQL editor AFTER setup.sql. It is safe to run
-- twice: accounts that already exist are skipped.
--
--   4 people are placed, one on each middle tier, so the chart has a chain
--     to drag onto:  Manager -> Engineer -> Station Head -> Asst Station Head
--   7 people are left as NEW SIGNUPS, so they queue in the left column
--     waiting to be dragged onto a block, a team, or an empty tier row.
--
-- Every account signs in with the password below, so you can also open the
-- app as one of them and see what that tier is allowed to do.
--
-- To remove them all again:
--   delete from auth.users where email like '%@demo.mjm';
-- (access_profiles rows go with them — the foreign key cascades.)
-- ---------------------------------------------------------------------------

-- The password every demo account shares.
--   Demo1234!
do $$
declare
  person record;
  new_id uuid;
  pw text := 'Demo1234!';
begin
  for person in
    select * from (values
      ('rahim.manager@demo.mjm',   'Rahim Abdullah'),
      ('chandran.eng@demo.mjm',    'Chandran Nair'),
      ('norhayati.sh@demo.mjm',    'Norhayati Salleh'),
      ('siti.ash@demo.mjm',        'Siti Aminah'),
      ('anand.new@demo.mjm',       'Anand Raj'),
      ('faiz.new@demo.mjm',        'Mohd Faiz'),
      ('devi.new@demo.mjm',        'Devi Suppiah'),
      ('zul.new@demo.mjm',         'Zulkifli Hassan'),
      ('meiling.new@demo.mjm',     'Tan Mei Ling'),
      ('joseph.new@demo.mjm',      'Joseph Anak Belaja'),
      ('aina.new@demo.mjm',        'Aina Rahman')
    ) as t(email, full_name)
  loop
    if exists (select 1 from auth.users u where u.email = person.email) then
      continue;
    end if;
    new_id := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', new_id, 'authenticated', 'authenticated',
      person.email, crypt(pw, gen_salt('bf')), now(),
      now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', person.full_name),
      '', '', '', ''
    );

    -- Sign-in also needs an identity row. Its columns differ between
    -- GoTrue versions, so a mismatch here must not lose the account: the
    -- chart only needs the profile, which the signup trigger just made.
    begin
      insert into auth.identities (
        id, user_id, identity_data, provider, provider_id,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), new_id,
        jsonb_build_object('sub', new_id::text, 'email', person.email),
        'email', new_id::text, now(), now(), now()
      );
    exception when others then
      null;
    end;

    -- The on_auth_user_created trigger writes access_profiles. If it was
    -- not installed, write the row here so the demo still works.
    insert into public.access_profiles (id, full_name, email, role, grade_id)
    values (
      new_id, person.full_name, person.email, 'operator',
      (select id from public.grades where name = 'Operator' limit 1)
    )
    on conflict (id) do update set full_name = excluded.full_name;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Place four of them on the chart, and leave the other seven queueing as
-- new signups. Written against the tier NAMES, so it follows whatever the
-- grades table says today.
-- ---------------------------------------------------------------------------
do $$
declare
  g_manager uuid := (select id from public.grades where name = 'Manager' limit 1);
  g_eng     uuid := (select id from public.grades where name = 'Engineer' limit 1);
  g_sh      uuid := (select id from public.grades where name = 'Station Head' limit 1);
  g_ash     uuid := (select id from public.grades where name = 'Assistant Station Head' limit 1);
  st_a      uuid := (select id from public.stations order by sort_order limit 1);
  id_manager uuid := (select id from public.access_profiles where email = 'rahim.manager@demo.mjm');
  id_eng     uuid := (select id from public.access_profiles where email = 'chandran.eng@demo.mjm');
  id_sh      uuid := (select id from public.access_profiles where email = 'norhayati.sh@demo.mjm');
  id_ash     uuid := (select id from public.access_profiles where email = 'siti.ash@demo.mjm');
begin
  update public.access_profiles set
    grade_id = g_manager, role = 'manager', supervisor_id = null,
    station_ids = '{}', station_id = null, tags_confirmed = true,
    employee_code = 'DEMO-01', basic_salary = 7500
    where id = id_manager;

  update public.access_profiles set
    grade_id = g_eng, role = 'engineer', supervisor_id = id_manager,
    station_ids = '{}', station_id = null, tags_confirmed = true,
    employee_code = 'DEMO-02', basic_salary = 5200
    where id = id_eng;

  update public.access_profiles set
    grade_id = g_sh, role = 'operator', supervisor_id = id_eng,
    station_ids = array[st_a], station_id = st_a, tags_confirmed = true,
    employee_code = 'DEMO-03', basic_salary = 3400
    where id = id_sh;

  update public.access_profiles set
    grade_id = g_ash, role = 'operator', supervisor_id = id_sh,
    station_ids = array[st_a], station_id = st_a, tags_confirmed = true,
    employee_code = 'DEMO-04', basic_salary = 2600
    where id = id_ash;

  -- The rest wait in the New signups column: no tier, no team, no leader.
  update public.access_profiles set
    grade_id = null, supervisor_id = null, team_id = null,
    station_ids = '{}', station_id = null, tags_confirmed = false
    where email in (
      'anand.new@demo.mjm', 'faiz.new@demo.mjm', 'devi.new@demo.mjm',
      'zul.new@demo.mjm', 'meiling.new@demo.mjm', 'joseph.new@demo.mjm',
      'aina.new@demo.mjm'
    );
end $$;

select email, full_name, tags_confirmed,
       (select name from public.grades g where g.id = p.grade_id) as tier
  from public.access_profiles p
 where email like '%@demo.mjm'
 order by tags_confirmed desc, email;
