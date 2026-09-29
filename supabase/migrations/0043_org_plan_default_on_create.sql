-- 0043_org_plan_default_on_create.sql
-- Console v1 follow-up (docs/plans/console-plan.md). 0042_org_plan.sql only
-- backfilled org_plan for orgs that already existed when it ran — nothing
-- guaranteed a row for orgs created AFTER that migration, which would have
-- made GET /console/orgs/:orgId's LEFT JOIN default (Pro/25) silently mask
-- a missing row forever, and left getPlanUsage() (once it reads org_plan,
-- see apps/web/src/lib/billing/plan.ts) with nothing real to read for any
-- new org.
--
-- Chosen mechanism: an AFTER INSERT trigger on organizations, not a change
-- to public.create_organization()'s body. Reason: create_organization() is
-- NOT the only path that inserts into organizations — supabase/seed.sql
-- (local dev/e2e fixture orgs) inserts directly with a plain `insert into
-- public.organizations (...)`, bypassing the RPC entirely. A trigger is the
-- only mechanism that covers every insert path uniformly (the RPC, seed
-- fixtures, and any future path) rather than requiring each one to
-- remember to also insert into org_plan. `on conflict do nothing` makes it
-- idempotent/safe to re-run.
--
-- SECURITY DEFINER, guarantees the insert succeeds regardless of the
-- firing role's own grants, since org_plan (0042) intentionally has zero
-- policies for authenticated/anon.
--
-- search_path = pg_catalog, public (not ''), matching
-- private.log_staff_action (0040_staff_audit_log.sql) rather than the
-- empty-search-path convention most other SECURITY DEFINER functions in
-- this schema use (confirm_pending_action, consume_pending_action,
-- log_copilot_tool_call, create_organization): this function, like
-- log_staff_action, is fired by a trigger on every insert into
-- organizations rather than invoked from a narrow, single call site, so
-- pinning to the standard pg_catalog+public search path (still immune to
-- schema-hijacking via a hostile search_path on the *calling* session,
-- since SECURITY DEFINER functions fix their own search_path on entry)
-- reads more predictably than an intentionally-broken empty path. Every
-- identifier below is fully schema-qualified regardless (public.org_plan,
-- new.id needs no qualification — it's a row field, not a name lookup),
-- so this is a belt-and-suspenders convention choice, not a correctness
-- requirement either way.

create or replace function private.set_default_org_plan()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.org_plan (org_id, plan_tier, workflow_limit)
  values (new.id, 'Pro', 25)
  on conflict (org_id) do nothing;

  return new;
end;
$$;

revoke execute on function private.set_default_org_plan() from public, anon, authenticated;

create trigger organizations_set_default_org_plan
  after insert on public.organizations
  for each row
  execute function private.set_default_org_plan();
