-- ---------------------------------------------------------------------------
-- "I approved this piece rate and it is back in the pending list."
--
-- Run these two queries in the Supabase SQL editor. Between them they say
-- whether the approval ever reached the database, and if it did, what put
-- the rate back. Read-only — nothing here changes any data.
-- ---------------------------------------------------------------------------

-- 1. What the database actually holds right now.
--    approval_status is the ONLY thing the pending list reads. If it says
--    'approved' here but the page still lists the rate, the page is stale —
--    reload it. Anything else, and the approval genuinely is not stored.
select
  s.name                as station,
  g.name                as tier_tag,
  j.name                as work_description,
  j.approval_status,
  j.verified_by,
  j.verified_at,
  j.approved_by,
  j.approved_at
from public.jobs j
left join public.stations s on s.id = j.station_id
left join public.grades   g on g.id = j.grade_id
where j.approval_status <> 'approved'
order by s.name, j.name;

-- 2. Every change ever made to those rates, newest first.
--    Each verify / approve / reject click writes one row here, so:
--      * no 'update' row from you  -> the click never reached the database.
--        The database refused it for your account (row level security). Your
--        tier tag needs Verify or Approve ticked under Piece rate setting.
--      * an approve, then a LATER update putting it back to pending -> the
--        approval was real and something undid it. The two usual causes are
--        editing the rate, tier 2 rate or effective date of an approved
--        contract (by design: a price change goes through the flow again),
--        and re-running setup.sql on a database that still had the old
--        cage-tipping consolidation block in it.
select
  a.at,
  a.action,
  coalesce(p.full_name, p.email, a.actor::text) as who,
  a.detail
from public.audit_log a
left join public.access_profiles p on p.id = a.actor
where a.target = 'jobs'
order by a.at desc
limit 100;
