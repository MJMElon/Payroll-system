-- ---------------------------------------------------------------------------
-- "+ Team" still refused? Run this.
--
-- "new row violates row-level security policy for table shared_teams" means the
-- table has row-level security switched on but no policy that lets you
-- write — which is what a half-applied setup.sql leaves behind, since the
-- Supabase SQL editor rolls the whole file back if any statement fails.
--
-- This re-states the shared_teams table, its grants and its policies on their own,
-- so it can be run without the rest of setup.sql. Safe to run twice.
-- ---------------------------------------------------------------------------
create table if not exists public.shared_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  grade_id uuid references public.shared_grades (id) on delete cascade,
  station_id uuid references public.shared_stations (id) on delete cascade,
  created_by uuid references public.shared_profiles (id) on delete set null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.shared_profiles add column if not exists team_id uuid
  references public.shared_teams (id) on delete set null;

alter table public.shared_teams enable row level security;

-- PostgREST talks to the database as these roles; without the grants every
-- request fails before a policy is ever consulted.
grant select, insert, update, delete on public.shared_teams to authenticated;
grant select on public.shared_teams to anon;

drop policy if exists "authenticated read shared_teams" on public.shared_teams;
create policy "authenticated read shared_teams" on public.shared_teams
  for select using (auth.uid() is not null);

-- Create / rename / remove a team: the tier that owns it and every tier
-- above, the granted user-settings function, or the account flagged admin
-- (the backstop that keeps a system from locking its own owner out).
drop policy if exists "leaders manage shared_teams" on public.shared_teams;
create policy "leaders manage shared_teams" on public.shared_teams
  for all using (
    public.my_role() = 'admin'
    or public.my_tag_tier() = 1
    or public.my_capabilities() && array['user-access', 'worker-assign-any']
    or (
      public.my_tag_tier() is not null
      and grade_id is not null
      and public.my_tag_tier() <= public.grade_tier(grade_id)
    )
  )
  with check (
    public.my_role() = 'admin'
    or public.my_tag_tier() = 1
    or public.my_capabilities() && array['user-access', 'worker-assign-any']
    or (
      public.my_tag_tier() is not null
      and grade_id is not null
      and public.my_tag_tier() <= public.grade_tier(grade_id)
    )
  );

-- What the database now believes about you, and what it will allow.
select
  (select email from public.shared_profiles where id = auth.uid()) as signed_in_as,
  public.my_tag_tier() as my_tier,
  public.my_role() as my_role;

select polname as policy, polcmd as command
  from pg_policy
 where polrelid = 'public.shared_teams'::regclass
 order by polname;
