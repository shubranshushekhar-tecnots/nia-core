-- 0078_console_copilot_rows_overrides.sql
-- Console build-out: Console-settable staff "grant" — a temporary (or
-- permanent-until-cleared) plan-tier + copilot/rows override, distinct
-- from the org/owner's actual base plan.
--
-- Design note (why a separate grant_* namespace instead of reusing
-- plan_id / the existing workflow_limit_set / project_limit_set columns):
-- org_plan.plan_id / owner_plan.plan_id is written by real subscription
-- state — apply_subscription_webhook() (0065_subscription_webhook_rpc.sql)
-- writes owner_plan.plan_id directly on every Razorpay webhook event, and
-- the signup/org-creation default triggers (0043/0051) write it too. If a
-- staff grant reused that same column with an expiry, the grant and the
-- customer's real paid plan would be the same mutable field — expiry
-- would have to fall back to a hardcoded plan (previously: 'free'),
-- destroying whatever the customer's actual subscription plan was. A
-- staff grant must be able to expire back to the base plan_id, not Free.
--
-- workflow_limit_set/workflow_limit and project_limit_set/project_limit
-- (0050_org_plan_overrides.sql/0051_owner_plan_table.sql) are left
-- completely untouched by this migration: they are permanent (no expiry
-- concept at all) and are read directly, independent of
-- private.effective_plan(), by apps/api/src/services/dashboard.ts,
-- services/billing.ts, services/consoleDashboard.ts and three integration
-- test files — none of which know about a time-limited grant. Renaming or
-- re-scoping those columns is out of scope here.
--
-- grant_plan_id (nullable): staff's temporary plan-tier override. Null
-- means "no plan-tier grant" — the effective plan is simply the base
-- plan_id. grant_copilot_actions_per_month(_set)/grant_rows_per_month(_set)
-- follow the same tri-state pattern 0050 already established for
-- workflow_limit/project_limit:
--   *_set = false            -> inherit the effective plan's own limit
--   *_set = true,  limit set  -> explicit cap, ignores the plan
--   *_set = true,  limit null -> explicit unlimited override
-- grant_expires_at is one column for the whole grant bundle (plan +
-- copilot + rows), not per field — matches the Console's single "Expiry"
-- input alongside the grant form. Null = grant never expires (stays
-- active until a staff member clears it). When past, the grant as a
-- whole is inactive: the effective plan reverts to the base plan_id, and
-- the copilot/rows overrides stop applying — workflow_limit_set/
-- project_limit_set are never affected by this (see above). grant_reason
-- is the staff-provided note from the most recent grant change, kept here
-- for display only — the governing audit trail is staff_audit_log
-- (private.log_staff_action), written by every PATCH route that touches
-- these columns.
--
-- Backfill: none needed. New columns default to false/null, so no
-- existing row's effective plan/limits change the moment this migration
-- runs (identical reasoning to 0050/0051's own backfill comments).

alter table public.org_plan
  add column grant_plan_id                          text references public.plans (id),
  add column grant_copilot_actions_per_month         integer,
  add column grant_copilot_actions_per_month_set     boolean not null default false,
  add column grant_rows_per_month                    integer,
  add column grant_rows_per_month_set                boolean not null default false,
  add column grant_expires_at                        timestamptz,
  add column grant_reason                            text;

alter table public.owner_plan
  add column grant_plan_id                          text references public.plans (id),
  add column grant_copilot_actions_per_month         integer,
  add column grant_copilot_actions_per_month_set     boolean not null default false,
  add column grant_rows_per_month                    integer,
  add column grant_rows_per_month_set                boolean not null default false,
  add column grant_expires_at                        timestamptz,
  add column grant_reason                            text;

comment on column public.org_plan.grant_plan_id is
  'Staff-granted temporary plan-tier override — null means no plan-tier grant (effective plan = plan_id). Distinct from plan_id, which is the org''s real base plan, written only by subscription/signup flows. Only effective while the grant is active (grant_expires_at is null or in the future) — see private.effective_plan().';
comment on column public.org_plan.grant_copilot_actions_per_month_set is
  'true = grant_copilot_actions_per_month (however set, including null) overrides the effective plan''s copilot_actions_per_month while the grant is active; false = inherit the effective plan''s limit.';
comment on column public.org_plan.grant_rows_per_month_set is
  'true = grant_rows_per_month (however set, including null) overrides the effective plan''s rows_per_month while the grant is active, enforced on every plan tier (not just Free); false = inherit the plan''s limit (Free-only enforcement, see private.effective_plan/assertRowsLimitNotExceeded/rowsLimitBlockMessage).';
comment on column public.org_plan.grant_expires_at is
  'When past, the entire grant (grant_plan_id and both grant_*_set overrides) is inactive: the effective plan reverts to plan_id (the base plan), with no grant overrides. Null = grant never expires. Never affects workflow_limit_set/project_limit_set, which are permanent and unrelated to this grant. Evaluated at read time by private.effective_plan() (used by every enforcement point: the two triggers below, chat.ts, runs.ts, apps/worker).';
comment on column public.org_plan.grant_reason is
  'Staff-provided note from the most recent grant change, for display only. The governing audit trail is staff_audit_log, written by every route that changes these columns.';

comment on column public.owner_plan.grant_plan_id is
  'Staff-granted temporary plan-tier override — null means no plan-tier grant (effective plan = plan_id). Distinct from plan_id, which is the user''s real base plan, written only by subscription/signup flows. Only effective while the grant is active (grant_expires_at is null or in the future) — see private.effective_plan().';
comment on column public.owner_plan.grant_copilot_actions_per_month_set is
  'true = grant_copilot_actions_per_month (however set, including null) overrides the effective plan''s copilot_actions_per_month while the grant is active; false = inherit the effective plan''s limit.';
comment on column public.owner_plan.grant_rows_per_month_set is
  'true = grant_rows_per_month (however set, including null) overrides the effective plan''s rows_per_month while the grant is active, enforced on every plan tier (not just Free); false = inherit the plan''s limit (Free-only enforcement, see private.effective_plan/assertRowsLimitNotExceeded/rowsLimitBlockMessage).';
comment on column public.owner_plan.grant_expires_at is
  'When past, the entire grant (grant_plan_id and both grant_*_set overrides) is inactive: the effective plan reverts to plan_id (the base plan), with no grant overrides. Null = grant never expires. Never affects workflow_limit_set/project_limit_set, which are permanent and unrelated to this grant. Evaluated at read time by private.effective_plan() (used by every enforcement point: the two triggers below, chat.ts, runs.ts, apps/worker).';
comment on column public.owner_plan.grant_reason is
  'Staff-provided note from the most recent grant change, for display only. The governing audit trail is staff_audit_log, written by every route that changes these columns.';

-- Single shared resolver, called by every enforcement point (the two DB
-- triggers below, apps/api's assertCopilotActionAllowed/
-- assertRowsLimitNotExceeded, and apps/worker's rowsLimitBlockMessage) so
-- the grant + expiry + "which table" branching logic lives in exactly one
-- place instead of being duplicated per call site. Exactly one of
-- p_org_id/p_user_id must be non-null (same org_id-xor-owner_id convention
-- used throughout this schema, e.g. workflows_org_xor_owner) — the UNION
-- ALL branch guarded by `... and p_org_id is not null` simply contributes
-- zero rows for whichever side is null.
--
-- workflow_limit/project_limit keep resolving against whichever plan is
-- *effective* (the grant's plan while active, else the base plan) through
-- their own pre-existing, ungated workflow_limit_set/project_limit_set
-- override flags — unchanged semantics, just now layered on top of a
-- grant-aware base instead of always the base plan_id directly.
create or replace function private.effective_plan(p_org_id uuid, p_user_id uuid default null)
returns table (
  plan_id                    text,
  plan_name                  text,
  workflow_limit             integer,
  project_limit              integer,
  copilot_actions_per_month  integer,
  rows_per_month             integer,
  rows_override_active       boolean,
  expired                    boolean
)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select
    eff.id as plan_id,
    eff.name as plan_name,
    case when base.workflow_limit_set then base.workflow_limit else eff.workflow_limit end as workflow_limit,
    case when base.project_limit_set then base.project_limit else eff.project_limit end as project_limit,
    case
      when base.grant_active and base.grant_copilot_actions_per_month_set then base.grant_copilot_actions_per_month
      else eff.copilot_actions_per_month
    end as copilot_actions_per_month,
    case
      when base.grant_active and base.grant_rows_per_month_set then base.grant_rows_per_month
      else eff.rows_per_month
    end as rows_per_month,
    (base.grant_active and base.grant_rows_per_month_set) as rows_override_active,
    (base.grant_expires_at is not null and base.grant_expires_at < now()) as expired
  from (
    select plan_id, workflow_limit_set, workflow_limit, project_limit_set, project_limit,
           grant_plan_id, grant_copilot_actions_per_month_set, grant_copilot_actions_per_month,
           grant_rows_per_month_set, grant_rows_per_month, grant_expires_at,
           (grant_expires_at is null or grant_expires_at >= now()) as grant_active
    from public.org_plan
    where org_id = p_org_id and p_org_id is not null
    union all
    select plan_id, workflow_limit_set, workflow_limit, project_limit_set, project_limit,
           grant_plan_id, grant_copilot_actions_per_month_set, grant_copilot_actions_per_month,
           grant_rows_per_month_set, grant_rows_per_month, grant_expires_at,
           (grant_expires_at is null or grant_expires_at >= now()) as grant_active
    from public.owner_plan
    where user_id = p_user_id and p_user_id is not null
  ) base
  join public.plans eff
    on eff.id = case when base.grant_active and base.grant_plan_id is not null then base.grant_plan_id else base.plan_id end;
$$;

comment on function private.effective_plan(uuid, uuid) is
  'Resolves the effective plan for an org (p_org_id) or a personal workspace (p_user_id) — exactly one argument must be non-null. If a staff grant is active (grant_expires_at null or in the future) and grant_plan_id is set, the effective plan is the grant''s plan; otherwise it is the base plan_id. copilot/rows overrides apply only while the grant is active; workflow/project overrides (workflow_limit_set/project_limit_set) are permanent and independent of the grant. Single source of truth for every enforcement/display point: enforce_workflow_limit, enforce_project_limit, assertCopilotActionAllowed, assertRowsLimitNotExceeded, apps/worker''s rowsLimitBlockMessage, and the Console''s org/user detail reads.';

revoke all on function private.effective_plan(uuid, uuid) from public, anon;
grant execute on function private.effective_plan(uuid, uuid) to authenticated, service_role;

-- Redefine the two DB-level enforcement triggers (0052/0053) to resolve
-- through private.effective_plan() instead of their own inline CASE WHEN
-- — same trigger, same advisory-lock keys, create or replace does not
-- need to re-attach it. Unchanged from the first version of this
-- migration (these functions only read private.effective_plan()'s output
-- columns, never org_plan/owner_plan's raw columns directly).

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
    select plan_name, workflow_limit into v_plan_name, v_limit from private.effective_plan(new.org_id, null);

    if v_limit is not null then
      select count(*) into v_count from public.workflows where org_id = new.org_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % workflow%. Delete one or upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA01';
      end if;
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 1));
    select plan_name, workflow_limit into v_plan_name, v_limit from private.effective_plan(null, new.owner_id);

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

create or replace function private.enforce_project_limit()
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
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 2));
    select plan_name, project_limit into v_plan_name, v_limit from private.effective_plan(new.org_id, null);

    if v_limit is not null then
      select count(*) into v_count from public.projects where org_id = new.org_id;
      if v_count >= v_limit then
        raise exception 'Your % plan allows % project%. Upgrade to add more.', v_plan_name, v_limit, (case when v_limit = 1 then '' else 's' end)
          using errcode = 'NIA02';
      end if;
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 3));
    select plan_name, project_limit into v_plan_name, v_limit from private.effective_plan(null, new.owner_id);

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
