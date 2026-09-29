-- 0042_org_plan.sql
-- Console v1, build order Step 7 (docs/plans/console-plan.md §5, §2,
-- decision 6).
--
-- org_plan: the first real plan/limits schema this project has ever had.
-- Before this migration, "plan" and "limit" existed only as a hardcoded
-- constant in apps/web/src/lib/billing/plan.ts's getPlanUsage(), which
-- returns `{ plan: 'Pro', limit: 25 }` (a workflow-count limit) for every
-- org, with no persisted row anywhere. Corrected per decision 6
-- (2026-09-28): this table must not invent columns with no current
-- default to backfill from — no seat limit or run limit exists today, so
-- only plan_tier and workflow_limit are modeled.
--
-- Backfill (below) sets plan_tier='Pro', workflow_limit=25 for every
-- existing org — this exactly reproduces today's hardcoded
-- getPlanUsage() behavior, so no org's effective limit changes the
-- moment this migration runs. apps/api/src/lib/orgPlan.integration.test.ts
-- proves this for every pre-existing (fixture-seeded) org.
--
-- RLS enabled, ZERO policies for v1 — same posture as platform_staff
-- (0039_platform_staff.sql) and staff_audit_log (0040_staff_audit_log.sql):
-- no authenticated/anon grant at all, only service_role/postgres. There is
-- no "plan_tier"/"workflow_limit" self-service surface yet (no
-- PATCH /console/orgs/:orgId/plan in this slice — that is a later build
-- order step, §3), so a zero-policy table is the correct default-deny
-- starting point, not a placeholder to be relaxed accidentally by a future
-- WHERE-clause change.
--
-- `updated_at`/`updated_by` exist now (unused by this migration's own
-- backfill, which leaves them at their defaults) purely so the later
-- PATCH endpoint doesn't need its own follow-up migration to add them.

create table public.org_plan (
  org_id          uuid primary key references public.organizations (id) on delete cascade,
  plan_tier       text not null default 'Pro',
  workflow_limit  integer,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public."user" (id)
);

comment on table public.org_plan is
  'Plan tier and workflow-count limit per org — the first persisted plan/'
  'limits schema (previously a hardcoded constant in apps/web/src/lib/'
  'billing/plan.ts''s getPlanUsage()). Backfilled to plan_tier=''Pro'', '
  'workflow_limit=25 for every org that existed when this migration ran, '
  'exactly reproducing getPlanUsage()''s prior behavior. RLS enabled with '
  'zero policies: no authenticated or anon access at all, only '
  'service_role/postgres. See docs/plans/console-plan.md.';

comment on column public.org_plan.workflow_limit is
  'Null means unlimited; matches getPlanUsage()''s existing "limit" '
  'semantics. Every pre-existing org is backfilled to 25, not null.';

comment on column public.org_plan.updated_by is
  'The staff user_id who last changed this org''s plan/limit, once a '
  'mutating endpoint exists. Null for the initial backfill row — no staff '
  'member set that value, the migration itself did.';

alter table public.org_plan enable row level security;

-- =========================================================================
-- Backfill — every org existing at migration time keeps exactly today's
-- implicit plan/limit (decision 6).
-- =========================================================================

insert into public.org_plan (org_id, plan_tier, workflow_limit)
select id, 'Pro', 25 from public.organizations;
