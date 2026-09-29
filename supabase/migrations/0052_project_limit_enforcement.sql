-- 0052_project_limit_enforcement.sql
-- Subscription model Phase 1, build order step 4: project_limit
-- enforcement, mirroring 0045_workflow_plan_enforcement.sql's
-- private.enforce_workflow_limit() shape exactly (BEFORE INSERT trigger on
-- public.projects, same org_id/owner_id xor shape as workflows —
-- 0005_individual_workspace.sql — same pg_advisory_xact_lock concurrency
-- guard, same "null = unlimited" semantics), but resolving the limit
-- through the new plans/org_plan/owner_plan override-flag columns (0049,
-- 0050, 0051) instead of a hardcoded constant, since project_limit did not
-- exist as a concept before this round.
--
-- Raises a NEW custom SQLSTATE ('NIA02', distinct from workflows' 'NIA01')
-- so apps/web/src/lib/dashboard/actions.ts can tell a project-limit hit
-- apart from a workflow-limit hit without string-matching. The message
-- names the plan (decision: "Your Free plan allows 1 project. Upgrade to
-- add more."), reading plans.name through the same join used to resolve
-- the limit itself.
--
-- This is the source of truth — apps/web's createProject pre-check (added
-- in the same round) is a fast-path/friendly-message convenience only,
-- exactly as 0045's own header comment says for workflows.

create or replace function private.enforce_project_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit     integer;
  v_limit_set boolean;
  v_plan_name text;
  v_count     integer;
begin
  if new.org_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 2));

    select pl.name,
           case when op.project_limit_set then op.project_limit else pl.project_limit end,
           op.project_limit_set
      into v_plan_name, v_limit, v_limit_set
      from public.org_plan op
      join public.plans pl on pl.id = op.plan_id
      where op.org_id = new.org_id;

    if v_limit is not null then
      select count(*) into v_count from public.projects where org_id = new.org_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % project%. Upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA02';
      end if;
    end if;
  else
    -- Personally-owned project (org_id is null, owner_id is not null per
    -- projects_org_xor_owner) — resolved through owner_plan instead.
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 3));

    select pl.name,
           case when op.project_limit_set then op.project_limit else pl.project_limit end,
           op.project_limit_set
      into v_plan_name, v_limit, v_limit_set
      from public.owner_plan op
      join public.plans pl on pl.id = op.plan_id
      where op.user_id = new.owner_id;

    if v_limit is not null then
      select count(*) into v_count from public.projects where owner_id = new.owner_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % project%. Upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA02';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function private.enforce_project_limit() from public, anon, authenticated, service_role;

create trigger projects_enforce_limit
  before insert on public.projects
  for each row
  execute function private.enforce_project_limit();
