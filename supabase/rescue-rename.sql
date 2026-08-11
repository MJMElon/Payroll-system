-- =============================================================================
-- RESCUE: module-prefix table renames + function refresh, and NOTHING else.
--
-- Run THIS FILE ALONE, first, if the app has lost access after the table
-- tidy-up. It renames any table still wearing its old name (each rename
-- skips itself once done) and re-creates every function that names a table,
-- so the access policies work again immediately. It is safe to run any
-- number of times. Afterwards, run the full setup.sql top to bottom.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- TABLE NAMES CARRY THEIR MODULE.
--
-- Every table is prefixed by the module that owns it, so the table list
-- reads like the app's sidebar:
--
--   shared_*      profiles, tier tags, stations, teams, audit log — data
--                 every module leans on. shared_workers is the LEGACY
--                 manual-worker list kept only for old payroll rows.
--   operation_*   work records: entries, photos, clock in/out.
--   piece_rate_*  the rate masterlist (piece_rate_jobs) and its amounts
--                 (piece_rates — the name already carries the prefix).
--   payroll_*     already prefixed; columns deliberately left as they are
--                 until that module gets its own rework.
--
-- A database built before this convention renames itself here, ONCE, before
-- anything else runs: each rename fires only while the old name still
-- exists and the new one does not, so re-running the file never loses a
-- row. Indexes, foreign keys, triggers and policies travel with a rename;
-- FUNCTION BODIES DO NOT — they are plain text — which is why the rest of
-- this file (all "create or replace function" statements included) speaks
-- the new names, and why this file must be run TOP TO BOTTOM after the
-- renames, never the tail alone.
-- ---------------------------------------------------------------------------
do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
    ['access_profiles',    'shared_profiles'],
    ['grades',             'shared_grades'],
    ['stations',           'shared_stations'],
    ['teams',              'shared_teams'],
    ['workers',            'shared_workers'],
    ['audit_log',          'shared_audit_log'],
    ['jobs',               'piece_rate_jobs'],
    ['production_entries', 'operation_entries'],
    ['photo_records',      'operation_photos'],
    ['attendance',         'operation_attendance']
  ]
  loop
    if to_regclass('public.' || pair[1]) is not null
       and to_regclass('public.' || pair[2]) is null then
      execute format('alter table public.%I rename to %I', pair[1], pair[2]);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- FUNCTIONS RE-SPOKEN IMMEDIATELY AFTER THE RENAMES.
--
-- A table rename carries its policies, indexes and triggers along — but a
-- function body is plain text, and every helper below still said the OLD
-- table names the moment the block above ran. The very first audited
-- statement then died inside log_audit() ("public.audit_log does not
-- exist") and took the whole run — and the app's access — with it, because
-- the policies lean on my_role() and my_capabilities().
--
-- So the exact final definitions from further down this file are repeated
-- here, before ANY statement that could call them. Running the file top to
-- bottom is now safe on a freshly renamed database; the later copies are
-- identical and simply re-assert these.
-- ---------------------------------------------------------------------------
-- On a FRESH database these tables do not exist yet at this point in the
-- file, and Postgres normally validates a "language sql" body against the
-- catalog at create time — so validation is off for this section only,
-- exactly the way pg_dump restores functions.
set check_function_bodies = off;


create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  op_grade uuid;
begin
  -- Every new signup starts as an Operator; leaders place them from there.
  select id into op_grade from public.shared_grades where name = 'Operator' limit 1;
  insert into public.shared_profiles (id, full_name, email, role, grade_id)
  values (
    new.id,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email,
    'operator',
    op_grade
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Never block a signup because profile creation failed; the app
  -- self-heals a missing profile on first login.
  return new;
end;
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.shared_profiles where id = auth.uid();
$$;

create or replace function public.my_tag_tier()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select g.sort_order from public.shared_profiles p
  join public.shared_grades g on g.id = p.grade_id
  where p.id = auth.uid();
$$;

create or replace function public.grade_tier(g uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select sort_order from public.shared_grades where id = g;
$$;

create or replace function public.bottom_tier()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(sort_order), 0) from public.shared_grades;
$$;

create or replace function public.my_capabilities()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  -- The coalesce has to sit OUTSIDE the select: an account with no tier tag
  -- matches no row at all, and a scalar subquery with no rows is null, not
  -- '{}'. Null then poisons every `my_capabilities() && array[...]` test in
  -- the policies below — the write is refused, silently, with no error.
  select coalesce(
    (
      select g.capabilities from public.shared_profiles p
      join public.shared_grades g on g.id = p.grade_id
      where p.id = auth.uid()
    ),
    '{}'
  );
$$;

create or replace function public.my_approval_screen()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select mobile_approval from public.shared_profiles where id = auth.uid();
$$;

create or replace function public.entry_period_locked(d date)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.payroll_runs
    where status = 'finalized' and period_start <= d and period_end >= d
  );
$$;

create or replace function public.block_locked_entry_changes()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and public.entry_period_locked(old.work_date) then
    raise exception 'Locked: this entry''s date falls in a finalized payroll period.';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.entry_period_locked(new.work_date) then
    raise exception 'Locked: that work date falls in a finalized payroll period.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.log_audit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb;
  tid uuid;
begin
  if tg_op = 'DELETE' then
    tid := old.id;
    d := to_jsonb(old);
  elsif tg_op = 'INSERT' then
    tid := new.id;
    d := to_jsonb(new);
  else
    tid := new.id;
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into d
      from jsonb_each(to_jsonb(new)) e
      where to_jsonb(old) -> e.key is distinct from e.value;
    if d = '{}'::jsonb then
      return new; -- nothing actually changed; keep the log quiet
    end if;
  end if;
  insert into public.shared_audit_log (actor, action, target, target_id, detail)
  values (auth.uid(), lower(tg_op), tg_table_name, tid, d);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.my_team_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.shared_profiles where id = auth.uid();
$$;

create or replace function public.manageable_team_ids()
returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t.id), '{}'::uuid[])
  from public.shared_teams t
  join public.shared_grades g on g.id = t.grade_id
  where public.my_tag_tier() is not null
    and public.my_tag_tier() <= g.sort_order;
$$;

create or replace function public.set_my_avatar(path text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.shared_profiles set avatar_path = path where id = auth.uid();
$$;

create or replace function public.set_my_details(code text, phone_no text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.shared_profiles
     set employee_code = case
           when public.my_role() = 'admin'
             or public.my_tag_tier() = 1
             or 'worker-id-edit' = any(public.my_capabilities())
           then nullif(btrim(coalesce(code, '')), '')
           else employee_code
         end,
         phone = nullif(btrim(coalesce(phone_no, '')), '')
   where id = auth.uid();
$$;

create or replace function public.guard_employee_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employee_code is distinct from old.employee_code
     and auth.uid() is not null
     and not (
       public.my_role() = 'admin'
       or public.my_tag_tier() = 1
       or 'worker-id-edit' = any(public.my_capabilities())
     )
  then
    raise exception 'Your tier is not allowed to change a Worker ID.';
  end if;
  return new;
end;
$$;

reset check_function_bodies;
