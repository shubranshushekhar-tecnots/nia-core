-- 0024_clean_plans.sql
-- Phase 13, Step 6 — CleanPlan: the binding recorded when a specialist-
-- authored cleaning PlanDiff (packages/schemas/src/cleanPlan.ts,
-- apps/worker/src/lib/clean/assemble.ts) is applied to a workflow node.
--
-- One row per (workflow_id, node_id) — a node has at most one active
-- CleanPlan binding at a time; re-proposing/re-applying replaces the row
-- (client upserts on this unique pair, see apps/api's
-- copilotDiffApply.ts::applyCleaningPlanDiff). Unlike
-- copilot_applied_plans (0023), this table is plain client CRUD under
-- RLS, not RPC-gated — it isn't itself the audit trail (that's still
-- audit_log, via log_cleaning_proposed below and 0023's
-- log_plan_diff_applied, per CONVENTIONS.md's "audit log is load-bearing"
-- note); it's a live pointer a run can look up and a manual edit can
-- delete (runEtl.ts's drift check, and the transform-editor save path's
-- "manual edit unbinds" rule per docs/plans/phase13.md Step 6).
--
-- applied_plan_id references the copilot_applied_plans row created by the
-- same apply call — deleting that row (e.g. a future admin cleanup) also
-- drops the binding, since a CleanPlan with no corresponding applied plan
-- is meaningless.

create table public.clean_plans (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  node_id text not null,
  applied_plan_id uuid not null references public.copilot_applied_plans (id) on delete cascade,
  -- See packages/schemas/src/cleanPlan.ts's CleanPlanRecord doc comment
  -- for what each hash covers and why they're kept separate.
  steps_hash text not null,
  source_schema_hash text not null,
  profile_hash text not null,
  op_catalog_version integer not null,
  adapter_version integer not null,
  applied_at timestamptz not null default now(),
  constraint clean_plans_unique_node unique (workflow_id, node_id)
);

create index clean_plans_workflow_id_idx on public.clean_plans (workflow_id);

alter table public.clean_plans enable row level security;

create policy "clean_plans_select_access"
  on public.clean_plans for select
  using (private.can_access_workflow(workflow_id));

create policy "clean_plans_insert_access"
  on public.clean_plans for insert
  with check (private.can_access_workflow(workflow_id));

create policy "clean_plans_update_access"
  on public.clean_plans for update
  using (private.can_access_workflow(workflow_id))
  with check (private.can_access_workflow(workflow_id));

create policy "clean_plans_delete_access"
  on public.clean_plans for delete
  using (private.can_access_workflow(workflow_id));

grant select, insert, update, delete on public.clean_plans to authenticated;

-- =========================================================================
-- log_cleaning_proposed — audit event for a "Propose cleaning" action
-- (Step 7), recording each specialist's prompt/output alongside the
-- resulting diff summary. Distinct from log_plan_diff_applied (0023),
-- which fires only when the user actually applies the resulting diff —
-- this fires at PROPOSE time regardless of whether the user ever applies
-- it, so the audit trail also captures proposals the user reviewed and
-- discarded (CONVENTIONS.md: "the audit log is load-bearing").
-- =========================================================================

create or replace function public.log_cleaning_proposed(
  p_workflow_id uuid,
  p_node_id text,
  p_summary text,
  p_specialists jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_owner_id uuid;
begin
  if not private.can_access_workflow(p_workflow_id) then
    raise exception 'not authorized for workflow %', p_workflow_id;
  end if;

  select org_id, owner_id into v_org_id, v_owner_id
  from public.workflows
  where id = p_workflow_id;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (
    v_org_id,
    v_owner_id,
    auth.uid(),
    'copilot_plan.cleaning_proposed',
    jsonb_build_object(
      'workflowId', p_workflow_id,
      'nodeId', p_node_id,
      'summary', p_summary,
      'specialists', p_specialists
    )
  );
end;
$$;

revoke execute on function public.log_cleaning_proposed(uuid, text, text, jsonb) from public, anon;
grant execute on function public.log_cleaning_proposed(uuid, text, text, jsonb) to authenticated;
