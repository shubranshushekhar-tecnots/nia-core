-- 0053_workflow_limit_uses_plans.sql
-- Subscription model Phase 1, build order step 5: redefines
-- private.enforce_workflow_limit() (0045_workflow_plan_enforcement.sql) to
-- resolve the limit through plans/org_plan/owner_plan's override-flag
-- columns instead of the old hardcoded "org_plan.org_id is null then 25"
-- default, and names the plan in the message (same wording decision as
-- 0052's project-limit message). Same trigger, same advisory-lock keys —
-- create or replace does not need to re-attach it.
--
-- Personally-owned workflows (org_id null, owner_id set) now resolve
-- through the new owner_plan table instead of a hardcoded Pro/25 literal —
-- owner_plan is guaranteed to have exactly one row per user as of 0051's
-- backfill + signup trigger, so no left-join-with-default is needed here
-- (unlike org_plan, which predates a guaranteed-row invariant and keeps its
-- own left join for that same historical reason elsewhere in the codebase).

create or replace function private.enforce_workflow_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit     integer;
  v_plan_name text;
  v_count     integer;
begin
  if new.org_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

    select pl.name,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end
      into v_plan_name, v_limit
      from public.org_plan op
      join public.plans pl on pl.id = op.plan_id
      where op.org_id = new.org_id;

    if v_limit is not null then
      select count(*) into v_count from public.workflows where org_id = new.org_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % workflow%. Delete one or upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA01';
      end if;
    end if;
  else
    -- Personally-owned workflow (org_id is null, owner_id is not null per
    -- workflows_org_xor_owner) — resolved through owner_plan instead of
    -- the old hardcoded Pro/25 literal.
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 1));

    select pl.name,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end
      into v_plan_name, v_limit
      from public.owner_plan op
      join public.plans pl on pl.id = op.plan_id
      where op.user_id = new.owner_id;

    if v_limit is not null then
      select count(*) into v_count from public.workflows where owner_id = new.owner_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % workflow%. Delete one or upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA01';
      end if;
    end if;
  end if;

  return new;
end;
$$;
