-- 0023_copilot_applied_plans.sql
-- Phase 12 — the diff model (docs/plans/phase12.md, docs/decisions.md's
-- Phase 12 entry). One row per PlanDiff (packages/schemas/src/planDiff.ts)
-- actually applied to a workflow's graph — both a normal Apply and a
-- Revert (which applies the inverse diff through this same path).
--
-- This is NOT a replacement for 0019's audit_log entry (still the
-- load-bearing record of who did what, per CLAUDE.md's can.ts note) —
-- audit_log stays the audit trail; this table additionally retains the
-- *diff itself*, needed so a later Revert can build the inverse
-- (invertDiff) and so checkRevertConflicts can compare live graph state
-- against exactly what this plan's ops left behind.
--
-- Phase 7's Plan/applyPlan (add-only, 0019's log_plan_applied) is left
-- entirely untouched by this migration and this phase — this table is
-- populated only by the new diff-apply path (apps/api's
-- copilotDiffApply.ts), never by the legacy Copilot propose/apply flow.
-- Plans applied through the legacy path (or through this path before this
-- migration existed) have no row here and are therefore never revertible
-- — phase12.md Design C's "Plans applied before Phase 12 are not
-- revertible."; the web UI checks for a row's existence to decide whether
-- to offer the Revert button rather than inferring it any other way.

create table public.copilot_applied_plans (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  summary text not null,
  prompt text not null default '',
  -- The exact PlanDiff that was applied — full op list with before/after
  -- snapshots, never a patch (planDiff.ts's header comment explains why).
  -- Stored verbatim so a revert can build its inverse without re-deriving
  -- it from anything else, and so checkRevertConflicts has the original
  -- "after" snapshots to compare the live graph against.
  diff jsonb not null,
  graph_version_after integer not null,
  applied_at timestamptz not null default now(),
  applied_by uuid not null default auth.uid(),
  reverted_at timestamptz,
  reverted_by uuid,
  -- The copilot_applied_plans row that reverted this one — set together
  -- with reverted_at/reverted_by, only via mark_plan_reverted below.
  revert_plan_id uuid references public.copilot_applied_plans (id),
  -- Set on a row that IS ITSELF a revert (its diff is an inverse diff) —
  -- which plan it reverted. A revert is applied through the exact same
  -- apply path as any other diff (phase12.md Design C), so it gets its
  -- own ordinary row here too; this column is what distinguishes it.
  reverts_plan_id uuid references public.copilot_applied_plans (id)
);

create index copilot_applied_plans_workflow_id_idx
  on public.copilot_applied_plans (workflow_id, applied_at desc);

alter table public.copilot_applied_plans enable row level security;

create policy "copilot_applied_plans_select_access"
  on public.copilot_applied_plans for select
  using (private.can_access_workflow(workflow_id));

create policy "copilot_applied_plans_insert_access"
  on public.copilot_applied_plans for insert
  with check (private.can_access_workflow(workflow_id));

-- No update/delete grant: reverted_at/reverted_by/revert_plan_id are only
-- ever set via mark_plan_reverted (SECURITY DEFINER) below — same
-- reasoning as audit_log itself having no client-insert path (0019's
-- header comment): a row's revert-state must always be paired with an
-- audit_log entry in the same transaction, which a bare client UPDATE
-- could never guarantee.
grant select, insert on public.copilot_applied_plans to authenticated;

-- =========================================================================
-- log_plan_diff_applied — audit event for an applied PlanDiff. Deliberately
-- a NEW rpc, not a reuse of 0019's log_plan_applied: that rpc's
-- `p_applied_node_ids uuid[]` parameter is shaped for the add-only Plan
-- contract (every element of a Plan is a new node). A PlanDiff's ops touch
-- nodes, edges, AND steps, so a single "node ids" array doesn't fit its
-- shape — this rpc's detail records the applied row id and op-kind list
-- instead, which is sufficient to look up the full diff via
-- copilot_applied_plans.id when needed.
-- =========================================================================

create or replace function public.log_plan_diff_applied(
  p_workflow_id uuid,
  p_applied_plan_id uuid,
  p_summary text,
  p_prompt text,
  p_op_kinds text[],
  p_graph_version integer
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
    'copilot_plan.diff_applied',
    jsonb_build_object(
      'workflowId', p_workflow_id,
      'appliedPlanId', p_applied_plan_id,
      'summary', p_summary,
      'prompt', p_prompt,
      'opKinds', to_jsonb(p_op_kinds),
      'graphVersion', p_graph_version
    )
  );
end;
$$;

revoke execute on function public.log_plan_diff_applied(uuid, uuid, text, text, text[], integer) from public, anon;
grant execute on function public.log_plan_diff_applied(uuid, uuid, text, text, text[], integer) to authenticated;

-- =========================================================================
-- mark_plan_reverted — the ONLY way a copilot_applied_plans row's
-- reverted_at/reverted_by/revert_plan_id get set, atomically paired with
-- its own audit_log entry referencing the original plan (phase12.md
-- Design C: "its own audit entry referencing the original plan"). Also
-- guards against reverting an already-reverted plan (the `where ...
-- reverted_at is null` + `if not found` pair below) — the API's own
-- pre-flight fetch should normally catch this first, but the guarantee
-- has to live here too since this is the actual write path.
--
-- p_revert_plan_id is the id of the NEW copilot_applied_plans row created
-- for the revert's own (inverse-diff) apply — inserted by the caller via
-- the plain insert grant above, same as any other apply, BEFORE calling
-- this rpc (mirrors 0019/log_plan_applied's split: the graph/row mutation
-- goes through the ordinary RLS-granted path, only the audit_log write
-- needs a SECURITY DEFINER rpc to close over its missing insert grant —
-- here that rpc also has to carry the reverted-state update, since that
-- column set has no update grant either, for the same "must never happen
-- without a paired audit entry" reason).
-- =========================================================================

create or replace function public.mark_plan_reverted(
  p_plan_id uuid,
  p_revert_plan_id uuid,
  p_prompt text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_id uuid;
  v_org_id uuid;
  v_owner_id uuid;
begin
  select workflow_id into v_workflow_id
  from public.copilot_applied_plans
  where id = p_plan_id;

  if v_workflow_id is null then
    raise exception 'plan % not found', p_plan_id;
  end if;

  if not private.can_access_workflow(v_workflow_id) then
    raise exception 'not authorized for workflow %', v_workflow_id;
  end if;

  update public.copilot_applied_plans
  set reverted_at = now(), reverted_by = auth.uid(), revert_plan_id = p_revert_plan_id
  where id = p_plan_id and reverted_at is null;

  if not found then
    raise exception 'plan % is already reverted', p_plan_id;
  end if;

  select org_id, owner_id into v_org_id, v_owner_id
  from public.workflows
  where id = v_workflow_id;

  insert into public.audit_log (org_id, owner_id, actor, action, detail)
  values (
    v_org_id,
    v_owner_id,
    auth.uid(),
    'copilot_plan.reverted',
    jsonb_build_object(
      'workflowId', v_workflow_id,
      'planId', p_plan_id,
      'revertPlanId', p_revert_plan_id,
      'prompt', p_prompt
    )
  );
end;
$$;

revoke execute on function public.mark_plan_reverted(uuid, uuid, text) from public, anon;
grant execute on function public.mark_plan_reverted(uuid, uuid, text) to authenticated;
