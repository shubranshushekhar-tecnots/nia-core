-- 0049_plans_table.sql
-- Subscription model Phase 1 (docs/plans/subscription-model.md, build order
-- step 1): the plan catalog. One row per plan tier; every limit column is
-- nullable = unlimited/unrestricted (same "null means unlimited" idiom as
-- org_plan.workflow_limit, 0042_org_plan.sql). org_plan/owner_plan (next two
-- migrations) reference plans.id and only ever override a subset of these
-- via their own explicit `*_set` flag columns — this table is the default,
-- never itself patched per-org.
--
-- 'legacy' is the hidden grandfather plan: every org/personal workspace that
-- existed before this migration is pointed at it (0050/0051) with no
-- overrides, so nobody's effective limits change today. It is not offered
-- for new signups (Console can still set it manually if ever needed).
--
-- Limit values below are taken verbatim from docs/plans/subscription-model.md's
-- pricing table; 'legacy' mirrors the pre-existing org_plan default
-- (workflow_limit=25, everything else unlimited/unrestricted, matching
-- 0042_org_plan.sql's backfill).

create table public.plans (
  id                          text primary key,
  name                        text not null,
  project_limit               integer,
  workflow_limit              integer,
  rows_per_month              integer,
  copilot_actions_per_month   integer,
  fastest_schedule_minutes    integer,
  run_history_days            integer,
  created_at                  timestamptz not null default now()
);

comment on table public.plans is
  'Subscription plan catalog. Every limit column is nullable = unlimited/unrestricted. Read-only catalog: no write grant, service_role/migrations only.';
comment on column public.plans.fastest_schedule_minutes is
  'Documented, not yet enforced — no scheduler exists yet (subscription-model.md Phase 1 notes).';

alter table public.plans enable row level security;

-- Public read-only catalog: every authenticated user can see every plan
-- (needed for the Console plan dropdown and any future self-serve upgrade
-- picker), but only migrations/service_role can write.
grant select on public.plans to authenticated;

create policy "plans_select_all"
  on public.plans for select
  to authenticated
  using (true);

insert into public.plans
  (id, name, project_limit, workflow_limit, rows_per_month, copilot_actions_per_month, fastest_schedule_minutes, run_history_days)
values
  ('legacy',     'Legacy',     null, 25,   null,     null, null,   null),
  ('free',       'Free',       1,    2,    100000,   50,   1440,   7),
  ('pro',        'Pro',        5,    null, 2000000,  500,  60,     30),
  ('team',       'Team',       null, null, 10000000, 2000, 15,     90),
  ('enterprise', 'Enterprise', null, null, null,     null, null,   365);
