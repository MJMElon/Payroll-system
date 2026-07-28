-- ---------------------------------------------------------------------------
-- TEN MORE DEMO USERS, all left in Pending Allocation.
--
-- Run in the Supabase SQL editor, after setup.sql. Safe to run twice:
-- accounts that already exist are skipped.
--
-- They arrive with no tier, no team, no station and no leader, so they all
-- queue in the left column of Team Manage ready to be dragged onto a tier
-- row, a team column, or an "+ Add person" slot.
--
-- Every account signs in with:  Demo1234!
--
-- To remove every demo account (this batch and the first):
--   delete from auth.users where email like '%@demo.mjm';
-- ---------------------------------------------------------------------------
do $$
declare
  person record;
  new_id uuid;
  pw text := 'Demo1234!';
begin
  for person in
    select * from (values
      ('hafiz.new@demo.mjm',    'Hafiz Bin Ramli'),
      ('sarah.new@demo.mjm',    'Sarah Lim Wei Ling'),
      ('bakri.new@demo.mjm',    'Bakri Bin Osman'),
      ('kalai.new@demo.mjm',    'Kalaivani Murugan'),
      ('jeffry.new@demo.mjm',   'Jeffry Anak Sagan'),
      ('nurul.new@demo.mjm',    'Nurul Ain Zakaria'),
      ('hendra.new@demo.mjm',   'Hendra Saputra'),
      ('vimala.new@demo.mjm',   'Vimala A/P Rajoo'),
      ('azlan.new@demo.mjm',    'Azlan Bin Yaakob'),
      ('chongwei.new@demo.mjm', 'Chong Wei Kit')
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
    -- GoTrue versions, so a mismatch must not lose the account: the chart
    -- only needs the profile, which the signup trigger just made.
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
    insert into public.access_profiles (id, full_name, email, role)
    values (new_id, person.full_name, person.email, 'operator')
    on conflict (id) do update set full_name = excluded.full_name;

    -- Queue the account THIS RUN created — no tier, no leader, no team, no
    -- station. Scoped to new_id on purpose: re-running this file must never
    -- undo an allocation someone has already made on the chart.
    update public.access_profiles set
      grade_id = null, supervisor_id = null, team_id = null,
      station_ids = '{}', station_id = null, tags_confirmed = false, role = 'operator'
     where id = new_id;
  end loop;
end $$;

select full_name, email, tags_confirmed as still_pending
  from public.access_profiles
 where email like '%.new@demo.mjm'
 order by full_name;

-- ---------------------------------------------------------------------------
-- RESET — run this BLOCK ON ITS OWN, and only when you want every demo name
-- thrown back into Pending Allocation. It is deliberately not part of the
-- seeding above: a seed that also resets would undo the allocations you had
-- just made every time you added more users.
-- ---------------------------------------------------------------------------
-- update public.access_profiles set
--   grade_id = null, supervisor_id = null, team_id = null,
--   station_ids = '{}', station_id = null, tags_confirmed = false, role = 'operator'
--  where email like '%@demo.mjm';
