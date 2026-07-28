-- ---------------------------------------------------------------------------
-- PUT AN ACCOUNT ON A TIER.
--
-- The Team Manage chart goes by the TIER TAG, not by the account's role, so
-- an account tagged Operator cannot reach the tiers above it however it is
-- flagged elsewhere — and the teams table refuses a "+ Team" from below the
-- tier that team belongs to. Setting your own tier is therefore a database
-- job: the page will not let you raise yourself, by design.
--
-- Run this in the Supabase SQL editor. Change the two values at the top to
-- point it somewhere else.
-- ---------------------------------------------------------------------------
do $$
declare
  target_email text := 'coco.lau@puigroups.com';
  target_tier  text := 'Management';
  g uuid;
begin
  select id into g from public.grades where name = target_tier limit 1;
  if g is null then
    raise exception 'No tier tag named %. Check Settings → Tier & Station Tags setting.', target_tier;
  end if;

  update public.access_profiles
     set grade_id = g,
         tags_confirmed = true
   where lower(email) = lower(target_email);

  if not found then
    raise exception 'No account with email %', target_email;
  end if;
end $$;

select p.email,
       p.full_name,
       g.name as tier,
       g.sort_order,
       p.role
  from public.access_profiles p
  left join public.grades g on g.id = p.grade_id
 where lower(p.email) = lower('coco.lau@puigroups.com');
