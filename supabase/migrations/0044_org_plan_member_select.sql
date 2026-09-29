-- 0044_org_plan_member_select.sql
-- Console v1 follow-up ("Slice 2 follow-ups" review). 0042_org_plan.sql
-- deliberately shipped with RLS enabled and ZERO policies/grants — there
-- was no customer-facing read surface yet, so apps/api/src/services/
-- dashboard.ts's getOrgPlan() had to go through withServiceRole
-- (service_role bypasses RLS entirely) just to read a customer's own
-- plan_tier/workflow_limit. That's a wider blast radius than the read
-- actually needs: service_role has no row-level restriction at all,
-- where the real requirement is only "an org member can see their OWN
-- org's plan/limit."
--
-- This narrows that gap with exactly one SELECT policy, scoped by
-- private.is_member(org_id) — the same helper every other per-org
-- table's own SELECT policy already uses (public.organizations, 0001;
-- public.projects/workflows, 0002; public.connections, 0007; etc.).
--
-- No INSERT/UPDATE/DELETE policy or grant is added here. org_plan
-- remains write-only via service_role/postgres (today: only the 0043
-- trigger; later: a staff-only PATCH endpoint) — this migration only
-- narrows the previously-zero READ surface. Probe 54
-- (supabase/tests/rls_probes.sql) is updated alongside this migration to
-- match: a member now reads their own org's row; a non-member still
-- gets zero rows (RLS-filtered, not a grant-level error, since the grant
-- below is unconditional for `authenticated` — the policy is what does
-- the actual scoping); INSERT still hard-fails with permission denied
-- for every authenticated user, member or not, since no INSERT grant
-- exists.

grant select on public.org_plan to authenticated;

create policy "org_plan_select_members"
  on public.org_plan for select
  using (private.is_member(org_id));
