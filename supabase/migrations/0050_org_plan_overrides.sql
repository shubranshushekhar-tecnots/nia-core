-- 0050_org_plan_overrides.sql
-- Subscription model Phase 1, build order step 2: point every org at a row
-- in the new plans catalog (0049), and give org_plan explicit per-limit
-- override flags instead of the single hardcoded workflow_limit column.
--
-- Override semantics (tri-state per limit, mirrors the codebase's existing
-- "presence distinguishes intent" idiom — e.g. org_id is null vs owner_id
-- set in 0005_individual_workspace.sql):
--   workflow_limit_set = false            -> inherit plans.workflow_limit
--   workflow_limit_set = true,  limit set  -> explicit cap, ignores the plan
--   workflow_limit_set = true,  limit null -> explicit unlimited override
-- project_limit/project_limit_set follow the identical shape.
--
-- Backfill is deliberately NOT an override: every existing org gets
-- plan_id='legacy', workflow_limit_set=false, project_limit_set=false, so
-- it inherits legacy's limits from the plans table (workflow_limit=25,
-- project_limit=null) rather than freezing today's literal column value as
-- a permanent per-org override. This matters because a later Legacy->Pro
-- plan change must actually change the org's effective limit — a baked-in
-- override would silently keep it capped at 25 forever. The one case where
-- an override IS still applied is a null workflow_limit (none exist today,
-- confirmed by direct query — all 4 current org_plan rows are 25 — but the
-- mapping below stays correct if one ever did): a null already means
-- "unlimited", and legacy's own plans.workflow_limit is 25, so preserving
-- that null requires workflow_limit_set=true to explicitly override the
-- plan's 25 with "unlimited" instead of silently losing it.
--
-- org_plan.plan_tier (0042_org_plan.sql) is left in place but deprecated:
-- plans.name (via the new plan_id) is now the source of truth for display
-- name. Nothing in this migration or later ones writes to plan_tier again.

alter table public.org_plan
  add column plan_id             text references public.plans(id),
  add column workflow_limit_set  boolean not null default false,
  add column project_limit       integer,
  add column project_limit_set   boolean not null default false;

comment on column public.org_plan.plan_tier is
  'Deprecated by plan_id (this migration) — plans.name is now the source of truth for display name. Left in place, no longer written to.';
comment on column public.org_plan.plan_id is
  'References plans.id. The org''s base plan; workflow_limit/project_limit only apply when their *_set flag is true, otherwise the plan''s own limit is effective.';
comment on column public.org_plan.workflow_limit_set is
  'true = workflow_limit (however set, including null) overrides plans.workflow_limit; false = inherit the plan''s limit.';
comment on column public.org_plan.project_limit is
  'Override value, only effective when project_limit_set is true. Null while set = explicit unlimited override.';
comment on column public.org_plan.project_limit_set is
  'true = project_limit (however set, including null) overrides plans.project_limit; false = inherit the plan''s limit.';

update public.org_plan
set plan_id = 'legacy',
    workflow_limit_set = (workflow_limit is null),
    project_limit_set = false;

alter table public.org_plan alter column plan_id set not null;

-- New orgs default to Free going forward (existing orgs stay on Legacy,
-- untouched by this migration). Redefines 0043_org_plan.sql's trigger
-- function in place — same SECURITY DEFINER / search_path shape, same
-- trigger (create or replace does not need to re-attach it).
create or replace function private.set_default_org_plan()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.org_plan (org_id, plan_id, plan_tier, workflow_limit)
  values (new.id, 'free', 'Free', null)
  on conflict (org_id) do nothing;
  return new;
end;
$$;
