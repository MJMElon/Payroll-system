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
  role text not null default 'worker'
    check (role in ('admin', 'manager', 'engineer', 'operator', 'worker')),
  station_id uuid references public.stations (id),
  worker_id uuid references public.workers (id),
  created_at timestamptz not null default now()
);

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
begin
  insert into public.access_profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
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
