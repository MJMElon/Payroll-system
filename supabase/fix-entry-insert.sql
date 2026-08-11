-- ---------------------------------------------------------------------------
-- "I took the photo, pressed Submit for approval, and nothing reached the
--  pending list."
--
-- Recording work is a TAG function — "Add New" under Work entry setting
-- (Settings → Tier tags) — and that is what the mobile Record tab and the
-- Daily Job Record form gate their buttons on. The row-level security
-- policy behind the table still went by the account's ROLE, and the two
-- disagreed:
--
--   * roleForTier() gives tier 3 the 'engineer' role, which is neither
--     admin/manager nor operator, so EVERY record that tier submitted was
--     refused outright;
--   * an 'operator' role whose station tags are empty matched no station,
--     so its records were refused too.
--
-- The button worked, the write did not. This re-states the policy in terms
-- of the tick, so the database agrees with the screens. Run it in Supabase
-- → SQL editor (it is also folded into setup.sql, so a full re-run of that
-- file does the same thing).
-- ---------------------------------------------------------------------------

drop policy if exists "insert production" on public.operation_entries;
create policy "insert production" on public.operation_entries
  for insert with check (
    -- Tier 1 is the super admin: every function, whatever is stored.
    public.my_tag_tier() = 1
    -- The tick itself, the same one the screens read.
    or 'data-entry' = any(public.my_capabilities())
    -- The original rule, kept so nothing that could record before stops:
    -- an account no tag has claimed yet, and the station-scoped operator.
    or public.my_role() in ('admin', 'manager')
    or (
      public.my_role() = 'operator'
      and exists (
        select 1 from public.shared_profiles p
        where p.id = auth.uid()
          and operation_entries.station_id = any(coalesce(p.station_ids, array[p.station_id]))
      )
    )
  );

-- What the policy now reads as, and which tags carry the tick.
select polname as policy, polcmd as command
  from pg_policy
 where polrelid = 'public.operation_entries'::regclass
 order by polname;

select sort_order as tier, name as tag,
       ('data-entry' = any(capabilities)) as can_add_new
  from public.shared_grades
 order by sort_order;
