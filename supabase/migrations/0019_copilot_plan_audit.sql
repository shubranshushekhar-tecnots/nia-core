-- 0019_copilot_plan_audit.sql
-- Phase 7 Session 2 — Copilot Apply's mandatory audit event.
--
-- audit_log (0001_auth_orgs.sql) only grants `select` to authenticated —
-- there is no client-insert path, by design (every audited mutation in
-- this codebase goes through a SECURITY DEFINER RPC that does the business
-- mutation and the audit_log insert together, see 0016_write_grants.sql's
-- create_write_grant/confirm_write_grant/revoke_write_grant). Apply's graph
-- mutation itself does NOT get a new RPC — it reuses the existing
-- workflow_graphs RLS-permitted UPDATE via putWorkflowGraph() (workflow_graphs
-- already grants insert/update directly to authenticated, gated by
-- private.can_access_workflow(), see 0012_workflow_graphs.sql) — only the
-- audit write is new, and only because audit_log itself has no insert grant
-- to close over.
--
-- Authorization here reuses private.can_access_workflow() verbatim rather
-- than re-deriving an org/owner membership check inline (that helper is
-- exactly the "single place this logic lives" 0012's header comment
-- documents) — this is not a new authorization check, it's the existing one
-- called from one more place.

create or replace function public.log_plan_applied(
  p_workflow_id uuid,
  p_plan_summary text,
  p_prompt text,
  p_applied_node_ids uuid[],
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
    'copilot_plan.applied',
    jsonb_build_object(
      'workflowId', p_workflow_id,
      'planSummary', p_plan_summary,
      'prompt', p_prompt,
      'appliedNodeIds', to_jsonb(p_applied_node_ids),
      'graphVersion', p_graph_version
    )
  );
end;
$$;

revoke execute on function public.log_plan_applied(uuid, text, text, uuid[], integer) from public, anon;
grant execute on function public.log_plan_applied(uuid, text, text, uuid[], integer) to authenticated;
