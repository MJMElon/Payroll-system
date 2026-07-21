-- Piece Rate & Payroll System — database setup
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Creates the core tables, row level security policies, the auto-profile
-- trigger, and seeds the 7 mill stations.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.stations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.workers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  station_id uuid references public.stations (id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per auth user. Mirrors src/lib/supabase.ts (Profile / Role types).
create table if not exists public.access_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'worker'
    check (role in ('admin', 'manager', 'engineer', 'operator', 'worker')),
  station_id uuid references public.stations (id),
  worker_id uuid references public.workers (id),
  created_at timestamptz not null default now()
);

alter table public.access_profiles add column if not exists email text;

-- ---------------------------------------------------------------------------
-- Auto-create a profile (role 'worker') whenever an auth user is created,
-- whether they sign up through the app or are added in the dashboard.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  op_grade uuid;
begin
  -- Every new signup starts as an Operator; admins upgrade access later.
  select id into op_grade from public.grades where name = 'Operator' limit 1;
  insert into public.access_profiles (id, full_name, email, role, grade_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Role helper. SECURITY DEFINER so policies on access_profiles can call it
-- without recursing into their own RLS checks.
-- ---------------------------------------------------------------------------

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.access_profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.stations enable row level security;
alter table public.workers enable row level security;
alter table public.access_profiles enable row level security;

-- access_profiles: everyone reads their own row; admins read and edit all.
drop policy if exists "read own profile" on public.access_profiles;
create policy "read own profile" on public.access_profiles
  for select using (id = auth.uid());

drop policy if exists "admin reads all profiles" on public.access_profiles;
create policy "admin reads all profiles" on public.access_profiles
  for select using (public.my_role() = 'admin');

drop policy if exists "admin updates profiles" on public.access_profiles;
create policy "admin updates profiles" on public.access_profiles
  for update using (public.my_role() = 'admin');

-- Users may create their own missing profile row (self-heal after signup).
drop policy if exists "insert own profile" on public.access_profiles;
create policy "insert own profile" on public.access_profiles
  for insert with check (id = auth.uid());

-- stations: any signed-in user can read; admins/managers manage.
drop policy if exists "authenticated read stations" on public.stations;
create policy "authenticated read stations" on public.stations
  for select using (auth.uid() is not null);

drop policy if exists "admin manager manage stations" on public.stations;
create policy "admin manager manage stations" on public.stations
  for all using (public.my_role() in ('admin', 'manager'));

-- workers: any signed-in user can read; admins/managers manage.
drop policy if exists "authenticated read workers" on public.workers;
create policy "authenticated read workers" on public.workers
  for select using (auth.uid() is not null);

drop policy if exists "admin manager manage workers" on public.workers;
create policy "admin manager manage workers" on public.workers
  for all using (public.my_role() in ('admin', 'manager'));

-- ---------------------------------------------------------------------------
-- Piece-rate work: grades (tags), jobs, rates, production entries
-- ---------------------------------------------------------------------------

-- Grades are the "tags" a piece rate belongs to (Operator, Station Head, …),
-- so the same work at the same station can be priced per grade.
create table if not exists public.grades (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id),
  name text not null,
  unit text not null default 'unit',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (station_id, name)
);

-- A piece-rate contract is the station × grade × work combination: add the
-- grade link and relax the old uniqueness so the same description can exist
-- per grade. (Idempotent for databases created from earlier versions.)
alter table public.jobs add column if not exists grade_id uuid references public.grades (id);
alter table public.jobs drop constraint if exists jobs_station_id_name_key;

-- Grade tag assigned to a worker/user (their station tag is workers.station_id).
alter table public.workers add column if not exists grade_id uuid references public.grades (id);

-- Per-user permission to approve new piece rates (a remark on the user,
-- not a grade tag). The old 'Piece rate approval' grade tag is retired.
alter table public.workers add column if not exists can_approve_rates boolean not null default false;

-- Login accounts carry their own tags + approval permission; access is
-- appointed per signed-up email in Settings -> User access (admin only).
alter table public.access_profiles add column if not exists grade_id uuid references public.grades (id);
alter table public.access_profiles add column if not exists can_approve_rates boolean not null default false;

-- A user can hold several station tags (empty = all stations).
alter table public.access_profiles add column if not exists station_ids uuid[];

-- Station work presets for the mobile view: hourly-counted stations expect
-- a target number of photo records every hour (the stamp card), plus a
-- minimum from the previous hour that unlocks this hour's bonus stamps.
alter table public.stations add column if not exists hourly_count boolean not null default false;
alter table public.stations add column if not exists hourly_target int not null default 6;
alter table public.stations add column if not exists hourly_min_prev int not null default 0;

-- ---------------------------------------------------------------------------
-- Per-user web access + signup confirmation flow
-- ---------------------------------------------------------------------------

-- Which modules THIS USER can see (moved from the tag to the user).
-- New signups default to seeing every module.
alter table public.access_profiles add column if not exists modules text[] not null
  default '{station-status,piece-rate,payroll,demo-mobile}';

-- New signups sit in the 'New sign up' pending list until an upper-tier
-- user confirms their tags.
alter table public.access_profiles add column if not exists tags_confirmed boolean not null default false;
update public.access_profiles set tags_confirmed = true
  where grade_id is not null and tags_confirmed = false;

-- Tier helpers for the confirmation rules. my_tag_tier is security definer
-- so policies can use it without RLS recursion.
create or replace function public.my_tag_tier()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select g.sort_order from public.access_profiles p
  join public.grades g on g.id = p.grade_id
  where p.id = auth.uid();
$$;

create or replace function public.grade_tier(g uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select sort_order from public.grades where id = g;
$$;

create or replace function public.bottom_tier()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(sort_order), 0) from public.grades;
$$;

-- Anyone at least one tier above the bottom may manage users BELOW their own
-- tier (claim new signups into their team, set station/tier tags). They can
-- never touch their own tier or above; admins are unrestricted (separate
-- policy above).
drop policy if exists "upper tier manages lower signups" on public.access_profiles;
create policy "upper tier manages lower signups" on public.access_profiles
  for update using (
    public.my_tag_tier() is not null
    and public.my_tag_tier() < public.bottom_tier()
    and id <> auth.uid()
    and (grade_id is null or public.grade_tier(grade_id) > public.my_tag_tier())
  )
  with check (
    grade_id is null or public.grade_tier(grade_id) > public.my_tag_tier()
  );

-- Photo records taken from the mobile view, one row per photo.
create table if not exists public.photo_records (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id),
  photo_path text,
  taken_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);
create index if not exists photo_records_station_time_idx
  on public.photo_records (station_id, taken_at);

alter table public.photo_records enable row level security;

drop policy if exists "authenticated read photo records" on public.photo_records;
create policy "authenticated read photo records" on public.photo_records
  for select using (auth.uid() is not null);

drop policy if exists "authenticated insert photo records" on public.photo_records;
create policy "authenticated insert photo records" on public.photo_records
  for insert with check (auth.uid() is not null);

drop policy if exists "admin manager delete photo records" on public.photo_records;
create policy "admin manager delete photo records" on public.photo_records
  for delete using (public.my_role() in ('admin', 'manager'));

-- Needed so an elapsed hour's photos can be linked to the production entry
-- auto-created from their count (sets entry_id after the fact).
drop policy if exists "owner links photo records to entry" on public.photo_records;
create policy "owner links photo records to entry" on public.photo_records
  for update using (
    created_by = auth.uid() or public.my_role() in ('admin', 'manager')
  );

-- Storage bucket for the photos (public so thumbnails render directly).
insert into storage.buckets (id, name, public)
values ('records', 'records', true)
on conflict (id) do nothing;

drop policy if exists "authenticated upload records" on storage.objects;
create policy "authenticated upload records" on storage.objects
  for insert with check (bucket_id = 'records' and auth.uid() is not null);

drop policy if exists "public read records" on storage.objects;
create policy "public read records" on storage.objects
  for select using (bucket_id = 'records');
update public.access_profiles set station_ids = array[station_id]
  where station_id is not null and station_ids is null;
update public.access_profiles p set email = u.email
  from auth.users u where u.id = p.id and p.email is null;

-- Display colour + ability text per tag, shown as the access legend.
alter table public.grades add column if not exists color text not null default 'grey';
alter table public.grades add column if not exists ability text;

-- What each tag can SEE on the web (module keys). New tags default to the
-- station board + piece rate module only.
alter table public.grades add column if not exists modules text[] not null
  default '{station-status,piece-rate}';

-- What each tag can DO — standardized capabilities:
--   data-entry: record work (photos / production entries)
--   verify:     verify work entries of all tiers below
--   approve:    approve work entries of all tiers below
alter table public.grades add column if not exists capabilities text[] not null default '{}';

-- Sensible defaults for the seeded tags (only fills empty ones).
update public.grades set capabilities = '{data-entry}'
  where name in ('Operator', 'Assistant Station Head', 'Station Head', 'General Worker')
    and capabilities = '{}';
update public.grades set capabilities = '{data-entry,verify}'
  where name = 'Engineer' and capabilities = '{}';
update public.grades set capabilities = '{verify}'
  where name = 'Manager' and capabilities = '{}';
update public.grades set capabilities = '{approve}'
  where name = 'Management' and capabilities = '{}';

-- The signed-in user's tag capabilities (security definer for policy use).
create or replace function public.my_capabilities()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(g.capabilities, '{}') from public.access_profiles p
  join public.grades g on g.id = p.grade_id
  where p.id = auth.uid();
$$;
update public.grades set modules = '{station-status,piece-rate,payroll,demo-mobile}'
  where name in ('Management', 'Manager', 'Engineer')
    and modules = '{station-status,piece-rate}';

-- Daily Job Record: for the tags that actually record production entries.
update public.grades set modules = array_append(modules, 'daily-job-record')
  where name in ('Operator', 'Assistant Station Head', 'Station Head', 'General Worker')
    and not ('daily-job-record' = any(modules));


update public.workers set grade_id = null
  where grade_id in (select id from public.grades where name = 'Piece rate approval');
update public.jobs set grade_id = null
  where grade_id in (select id from public.grades where name = 'Piece rate approval');
delete from public.grades where name = 'Piece rate approval';

-- New piece rates go through a two-step flow: proposed (pending) ->
-- verified (by an approver preset to 'verify') -> approved (preset
-- 'approve'). Who did each step is recorded. Existing rows default approved.
alter table public.jobs add column if not exists approval_status text not null default 'approved'
  check (approval_status in ('pending', 'approved', 'rejected'));
alter table public.jobs drop constraint if exists jobs_approval_status_check;
alter table public.jobs add constraint jobs_approval_status_check
  check (approval_status in ('pending', 'verified', 'approved', 'rejected'));
alter table public.jobs add column if not exists verified_by text;
alter table public.jobs add column if not exists verified_at timestamptz;
alter table public.jobs add column if not exists approved_by text;
alter table public.jobs add column if not exists approved_at timestamptz;

-- Each approver email is preset to its step in the approval process.
alter table public.access_profiles add column if not exists approval_role text
  check (approval_role in ('verify', 'approve'));

-- Approvers may update jobs (verify/approve/reject) even without the
-- admin/manager role.
drop policy if exists "approvers update jobs" on public.jobs;
create policy "approvers update jobs" on public.jobs
  for update using (
    exists (
      select 1 from public.access_profiles p
      where p.id = auth.uid() and p.can_approve_rates
    )
    or public.my_capabilities() && array['verify', 'approve']
  );
create unique index if not exists jobs_station_grade_name_idx
  on public.jobs (station_id, grade_id, name);

-- Rate history per job. The rate in force on a date is the newest row with
-- effective_from <= that date.
create table if not exists public.piece_rates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  rate numeric(12,4) not null check (rate >= 0),
  effective_from date not null default current_date,
  created_at timestamptz not null default now(),
  unique (job_id, effective_from)
);

create table if not exists public.production_entries (
  id uuid primary key default gen_random_uuid(),
  work_date date not null default current_date,
  station_id uuid not null references public.stations (id),
  job_id uuid not null references public.jobs (id),
  worker_id uuid not null references public.workers (id),
  quantity numeric(12,3) not null check (quantity > 0),
  notes text,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists production_entries_work_date_idx
  on public.production_entries (work_date);

-- ---------------------------------------------------------------------------
-- Payroll runs
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

-- One line per worker + job in the period; rate is snapshotted at run time.
create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  worker_id uuid not null references public.workers (id),
  job_id uuid not null references public.jobs (id),
  quantity numeric(12,3) not null,
  rate numeric(12,4) not null,
  amount numeric(14,2) not null
);

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  worker_id uuid not null references public.workers (id),
  amount numeric(14,2) not null,
  reason text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS for the work tables
-- ---------------------------------------------------------------------------

alter table public.jobs enable row level security;
alter table public.piece_rates enable row level security;
alter table public.production_entries enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_lines enable row level security;
alter table public.payroll_adjustments enable row level security;

alter table public.grades enable row level security;

drop policy if exists "authenticated read grades" on public.grades;
create policy "authenticated read grades" on public.grades
  for select using (auth.uid() is not null);

-- Only admins or tier-1 (Management) users manage tags.
drop policy if exists "admin manager manage grades" on public.grades;
drop policy if exists "management tier manages grades" on public.grades;
create policy "management tier manages grades" on public.grades
  for all using (public.my_role() = 'admin' or public.my_tag_tier() = 1);

-- jobs / piece_rates: any signed-in user reads; admins/managers manage.
drop policy if exists "authenticated read jobs" on public.jobs;
create policy "authenticated read jobs" on public.jobs
  for select using (auth.uid() is not null);

drop policy if exists "admin manager manage jobs" on public.jobs;
create policy "admin manager manage jobs" on public.jobs
  for all using (public.my_role() in ('admin', 'manager'));

drop policy if exists "authenticated read piece_rates" on public.piece_rates;
create policy "authenticated read piece_rates" on public.piece_rates
  for select using (auth.uid() is not null);

drop policy if exists "admin manager manage piece_rates" on public.piece_rates;
create policy "admin manager manage piece_rates" on public.piece_rates
  for all using (public.my_role() in ('admin', 'manager'));

-- production entries: everyone signed-in reads; admins/managers write freely;
-- operators may only record for their own station and delete their own rows.
drop policy if exists "authenticated read production" on public.production_entries;
create policy "authenticated read production" on public.production_entries
  for select using (auth.uid() is not null);

drop policy if exists "insert production" on public.production_entries;
create policy "insert production" on public.production_entries
  for insert with check (
    public.my_role() in ('admin', 'manager')
    or (
      public.my_role() = 'operator'
      and exists (
        select 1 from public.access_profiles p
        where p.id = auth.uid()
          and production_entries.station_id = any(coalesce(p.station_ids, array[p.station_id]))
      )
    )
  );

drop policy if exists "delete production" on public.production_entries;
create policy "delete production" on public.production_entries
  for delete using (
    public.my_role() in ('admin', 'manager')
    or (public.my_role() = 'operator' and created_by = auth.uid())
  );

-- payroll: admins/managers only.
drop policy if exists "admin manager payroll_runs" on public.payroll_runs;
create policy "admin manager payroll_runs" on public.payroll_runs
  for all using (public.my_role() in ('admin', 'manager'));

drop policy if exists "admin manager payroll_lines" on public.payroll_lines;
create policy "admin manager payroll_lines" on public.payroll_lines
  for all using (public.my_role() in ('admin', 'manager'));

drop policy if exists "admin manager payroll_adjustments" on public.payroll_adjustments;
create policy "admin manager payroll_adjustments" on public.payroll_adjustments
  for all using (public.my_role() in ('admin', 'manager'));

-- ---------------------------------------------------------------------------
-- Workers -> users unification (Option A). Work and pay now attach to the
-- signed-up USER; the old workers table stays read-only for history.
-- ---------------------------------------------------------------------------

-- Everyone signed in may read profiles (needed to show names on entries,
-- boards and payslips). Writing is still admin-only.
drop policy if exists "authenticated read profiles" on public.access_profiles;
create policy "authenticated read profiles" on public.access_profiles
  for select using (auth.uid() is not null);

alter table public.production_entries add column if not exists user_id uuid references public.access_profiles (id);
alter table public.production_entries alter column worker_id drop not null;
alter table public.payroll_lines add column if not exists user_id uuid references public.access_profiles (id);
alter table public.payroll_lines alter column worker_id drop not null;
alter table public.payroll_adjustments add column if not exists user_id uuid references public.access_profiles (id);
alter table public.payroll_adjustments alter column worker_id drop not null;

-- Backfill: rows whose worker is already linked to an account.
update public.production_entries pe set user_id = ap.id
  from public.access_profiles ap
  where ap.worker_id = pe.worker_id and pe.user_id is null and pe.worker_id is not null;
update public.payroll_lines pl set user_id = ap.id
  from public.access_profiles ap
  where ap.worker_id = pl.worker_id and pl.user_id is null and pl.worker_id is not null;
update public.payroll_adjustments pa set user_id = ap.id
  from public.access_profiles ap
  where ap.worker_id = pa.worker_id and pa.user_id is null and pa.worker_id is not null;

-- ---------------------------------------------------------------------------
-- Mobile work-entry approval flow. Entries submitted from the mobile view
-- start 'pending' and are verified/approved by upper tiers (same states as
-- piece rates). Old rows default to 'approved' so history stays payable.
-- Photos can attach to a specific entry as evidence.
-- ---------------------------------------------------------------------------
alter table public.production_entries add column if not exists approval_status text not null default 'approved';
alter table public.production_entries drop constraint if exists production_entries_approval_status_check;
alter table public.production_entries add constraint production_entries_approval_status_check
  check (approval_status in ('pending', 'verified', 'approved', 'rejected'));
alter table public.production_entries add column if not exists verified_by text;
alter table public.production_entries add column if not exists verified_at timestamptz;
alter table public.production_entries add column if not exists approved_by text;
alter table public.production_entries add column if not exists approved_at timestamptz;
alter table public.photo_records add column if not exists entry_id uuid references public.production_entries (id) on delete set null;

-- Hourly piece-work photos (mobile view): each photo is tagged with the job
-- it's being counted against, so an elapsed hour's photo count can convert
-- into a production entry priced at that job's approved rate.
alter table public.photo_records add column if not exists job_id uuid references public.jobs (id);

-- Tiers holding the verify/approve capability may update entries below them.
drop policy if exists "verifiers update production" on public.production_entries;
create policy "verifiers update production" on public.production_entries
  for update using (
    public.my_role() in ('admin', 'manager')
    or public.my_capabilities() && array['verify', 'approve']
  );

-- Seed only when the table is empty, so stations you delete stay deleted
-- on later re-runs.
insert into public.stations (name, sort_order)
select v.name, v.sort_order from (values
  ('Loading Ramp', 1),
  ('Sterilizer', 2),
  ('Thresher', 3),
  ('Press', 4),
  ('Clarification', 5),
  ('Kernel Recovery', 6),
  ('Boiler', 7)
) as v(name, sort_order)
where not exists (select 1 from public.stations);

-- Starter grades (tags) — tier 1 is the HIGHEST; a tier sees every tier
-- below it. Seeded only when the table is empty, so tags you delete or
-- re-order stay that way on later re-runs.
insert into public.grades (name, sort_order)
select v.name, v.sort_order from (values
  ('Management', 1),
  ('Manager', 2),
  ('Engineer', 3),
  ('Station Head', 4),
  ('Assistant Station Head', 5),
  ('Operator', 6),
  ('General Worker', 7)
) as v(name, sort_order)
where not exists (select 1 from public.grades);

-- One-time remap for databases created before tier-1-was-highest (detected
-- by Operator still sitting above Management).
do $$
begin
  if exists (
    select 1 from public.grades m, public.grades o
    where m.name = 'Management' and o.name = 'Operator' and m.sort_order > o.sort_order
  ) then
    update public.grades set sort_order = 1 where name = 'Management';
    update public.grades set sort_order = 2 where name = 'Manager';
    update public.grades set sort_order = 3 where name = 'Engineer';
    update public.grades set sort_order = 4 where name = 'Station Head';
    update public.grades set sort_order = 5 where name = 'Assistant Station Head';
    update public.grades set sort_order = 6 where name = 'Operator';
    update public.grades set sort_order = 7 where name = 'General Worker';
  end if;
end $$;

-- Default colours/abilities (only fills tags still on the default grey).
update public.grades set color = 'blue',
  ability = 'Sees own level piece rates; records production at own station'
  where name = 'Operator' and color = 'grey';
update public.grades set color = 'yellow',
  ability = 'Sees own and operator level piece rates'
  where name = 'Assistant Station Head' and color = 'grey';
update public.grades set color = 'red',
  ability = 'Sees own level and below piece rates'
  where name = 'Station Head' and color = 'grey';
update public.grades set color = 'silver',
  ability = 'Can propose new piece rates; sees own level and below'
  where name = 'Engineer' and color = 'grey';
update public.grades set color = 'gold',
  ability = 'Verifies new piece rates before management approval'
  where name = 'Manager' and color = 'grey';
update public.grades set color = 'diamond',
  ability = 'Final approval of each new piece rate; sees everything'
  where name = 'Management' and color = 'grey';

-- ---------------------------------------------------------------------------
-- Standardized capabilities v2. Piece-rate rights get their own keys
-- (rate-create / rate-verify / rate-approve), station and tag management
-- become grantable capabilities, and seeing the report module (dashboards)
-- is a capability too. Backfill from the old verify/approve flags so
-- existing tags keep working after the split.
-- ---------------------------------------------------------------------------
update public.grades set capabilities = capabilities || '{rate-verify}'
  where 'verify' = any(capabilities) and not 'rate-verify' = any(capabilities);
update public.grades set capabilities = capabilities || '{rate-approve}'
  where 'approve' = any(capabilities) and not 'rate-approve' = any(capabilities);
update public.grades set capabilities = capabilities || '{report-view}'
  where ('verify' = any(capabilities) or 'approve' = any(capabilities))
    and not 'report-view' = any(capabilities);

-- Tier 1 (Management) is the SUPER ADMIN: pinned at #1 and always holding
-- every ability. Re-asserted on every run so it can never drift.
update public.grades set capabilities =
  '{data-entry,verify,approve,rate-create,rate-verify,rate-approve,station-create,tag-edit,report-view}'
  where sort_order = 1;

-- Tag editing and station management follow the granted capabilities, not
-- only the admin/manager roles — so the super admin can open the "edit
-- tags" / "create stations" functions to chosen tiers.
drop policy if exists "management tier manages grades" on public.grades;
create policy "management tier manages grades" on public.grades
  for all using (
    public.my_role() = 'admin'
    or public.my_tag_tier() = 1
    or 'tag-edit' = any(public.my_capabilities())
  );

drop policy if exists "admin manager manage stations" on public.stations;
create policy "admin manager manage stations" on public.stations
  for all using (
    public.my_role() in ('admin', 'manager')
    or public.my_tag_tier() = 1
    or 'station-create' = any(public.my_capabilities())
  );

-- ---------------------------------------------------------------------------
-- Daily Job Record form: shift worked + an optional employee code shown
-- next to the name in the employee picker (e.g. "Ali Bin Ahmad (EMP001)").
-- ---------------------------------------------------------------------------

alter table public.production_entries add column if not exists shift text;

-- Only Shift A / Shift B are offered — remap any rows saved under the
-- earlier morning/afternoon/night options before tightening the check.
update public.production_entries set shift = 'a' where shift in ('morning', 'afternoon');
update public.production_entries set shift = 'b' where shift = 'night';

alter table public.production_entries drop constraint if exists production_entries_shift_check;
alter table public.production_entries add constraint production_entries_shift_check
  check (shift is null or shift in ('a', 'b'));

alter table public.access_profiles add column if not exists employee_code text;
create unique index if not exists access_profiles_employee_code_idx
  on public.access_profiles (employee_code) where employee_code is not null;

-- ---------------------------------------------------------------------------
-- Tiered hourly piece rates (e.g. cage tipping): a job's rate can pay one
-- rate for the first 4 units done in an hour and a second, higher rate for
-- the 5th unit onward that same hour — resetting every hour. `rate` stays
-- Tier 1; `tier2_rate` is null for an ordinary flat-rate job.
-- ---------------------------------------------------------------------------
alter table public.piece_rates add column if not exists tier2_rate numeric(12,4);

-- One-time consolidation for the Sterilizer & Tippler Station cage-tipping
-- rates: the Operator tag priced this as two separately-named jobs (a
-- workaround for not having real tiering); fold them into one tiered job
-- named plainly "FFB Cages Tipped" so it lines up with the Assistant Station
-- Head / Station Head rows of the same name. Idempotent — a second run finds
-- nothing left to rename.
do $$
declare
  ffb_station uuid;
  op_grade uuid;
  ash_grade uuid;
  sh_grade uuid;
  first4_job uuid;
  fifth_job uuid;
  plain_job uuid;
  fifth_rate numeric;
begin
  select id into ffb_station from public.stations where name = 'Sterilizer & Tippler Station';
  if ffb_station is null then return; end if;

  select id into op_grade from public.grades where name = 'Operator';
  select id into ash_grade from public.grades where name = 'Assistant Station Head';
  select id into sh_grade from public.grades where name = 'Station Head';

  select id into first4_job from public.jobs
    where station_id = ffb_station and grade_id = op_grade
      and name = 'FFB Cages Tipped (First to Fourth Cages of the hour)';
  select id into fifth_job from public.jobs
    where station_id = ffb_station and grade_id = op_grade
      and name = 'FFB Cages Tipped (Fifth Cages onward of the hour)';

  if first4_job is not null and fifth_job is not null then
    select rate into fifth_rate from public.piece_rates
      where job_id = fifth_job order by effective_from desc limit 1;

    update public.piece_rates set tier2_rate = fifth_rate
      where job_id = first4_job
        and effective_from = (
          select max(effective_from) from public.piece_rates where job_id = first4_job
        );

    update public.jobs set name = 'FFB Cages Tipped' where id = first4_job;
    -- Retired, not deleted — existing production_entries/photo_records still
    -- reference it, and its piece_rates history stays intact for their payout.
    update public.jobs set active = false where id = fifth_job;
  end if;

  -- Roll tiering out to Assistant Station Head / Station Head too. Their
  -- existing flat rate becomes Tier 1; Tier 2 is unset until someone fills
  -- it in, so the job needs re-approval before it's usable again.
  select id into plain_job from public.jobs
    where station_id = ffb_station and grade_id = ash_grade and name = 'FFB Cages Tipped';
  if plain_job is not null then
    update public.jobs set approval_status = 'pending'
      where id = plain_job and approval_status = 'approved';
  end if;

  select id into plain_job from public.jobs
    where station_id = ffb_station and grade_id = sh_grade and name = 'FFB Cages Tipped';
  if plain_job is not null then
    update public.jobs set approval_status = 'pending'
      where id = plain_job and approval_status = 'approved';
  end if;
end $$;
