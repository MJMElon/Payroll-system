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
update public.access_profiles p set email = u.email
  from auth.users u where u.id = p.id and p.email is null;

-- Display colour + ability text per tag, shown as the access legend.
alter table public.grades add column if not exists color text not null default 'grey';
alter table public.grades add column if not exists ability text;

-- What each tag can SEE on the web (module keys). New tags default to the
-- station board + piece rate module only.
alter table public.grades add column if not exists modules text[] not null
  default '{station-status,piece-rate}';
update public.grades set modules = '{station-status,piece-rate,payroll,demo-mobile}'
  where name in ('Management', 'Manager', 'Engineer');

-- The signed-in user's tag tier (security definer avoids RLS recursion when
-- used inside the grades policies).
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
    or public.my_tag_tier() in (1, 2)
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
      and station_id = (select station_id from public.access_profiles where id = auth.uid())
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
-- Seed the 7 mill stations
-- ---------------------------------------------------------------------------

insert into public.stations (name, sort_order) values
  ('Loading Ramp', 1),
  ('Sterilizer', 2),
  ('Thresher', 3),
  ('Press', 4),
  ('Clarification', 5),
  ('Kernel Recovery', 6),
  ('Boiler', 7)
on conflict (name) do nothing;

-- Starter grades (tags) — tier 1 is the HIGHEST; a tier sees every tier
-- below it. Reorder by dragging in Settings -> Tags management.
insert into public.grades (name, sort_order) values
  ('Management', 1),
  ('Manager', 2),
  ('Engineer', 3),
  ('Station Head', 4),
  ('Assistant Station Head', 5),
  ('Operator', 6),
  ('General Worker', 7)
on conflict (name) do nothing;

-- Remap the seeded tags to tier-1-is-highest (older databases had the
-- opposite order).
update public.grades set sort_order = 1 where name = 'Management';
update public.grades set sort_order = 2 where name = 'Manager';
update public.grades set sort_order = 3 where name = 'Engineer';
update public.grades set sort_order = 4 where name = 'Station Head';
update public.grades set sort_order = 5 where name = 'Assistant Station Head';
update public.grades set sort_order = 6 where name = 'Operator';
update public.grades set sort_order = 7 where name = 'General Worker';

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
