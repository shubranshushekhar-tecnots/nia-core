-- 0076_agent_action_audit_detail.sql
-- Safeguards slice (audit requirement): 0074's create_agent_setup_action_task
-- logs every one of the six UI-facing actions (test, run now, full reload,
-- pause, resume, allow one large delete) as the same generic
-- kind='run_now' detail, {workflowId, kind} — full_reload and
-- allow_mass_delete are indistinguishable from a plain run_now in the
-- audit trail today. This widens the logged detail to include the
-- request's own flags (fullReload, allowMassDelete) alongside kind, so an
-- auditor can tell the three run_now-family actions apart.
--
-- p_payload with the `params` key stripped (`p_payload - 'params'`) —
-- run_now's payload can carry one-off parameter *values* for this run
-- (apps/api/src/services/agentSetupActions.ts's AgentSetupActionRequest.params),
-- which must never land in audit_log per this slice's "never a secret,
-- key, password, row value, or parameter value" rule. fullReload/
-- allowMassDelete are plain booleans the request already carries
-- regardless of params, so stripping only that one key keeps them intact.
--
-- Only this function changes; its authorization, task-insert, and
-- notify behaviour are byte-for-byte the same as 0074.

create or replace function public.create_agent_setup_action_task(
  p_workflow_id uuid,
  p_kind text,
  p_payload jsonb default '{}'::jsonb
)
returns public.agent_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_org_id uuid;
  v_workflow_owner_id uuid;
  v_setup public.agent_setups;
  v_row public.agent_tasks;
begin
  if p_kind not in ('run_now', 'pause', 'resume', 'test_job') then
    raise exception 'unsupported action kind %', p_kind;
  end if;

  select org_id, owner_id into v_workflow_org_id, v_workflow_owner_id
  from public.workflows where id = p_workflow_id;

  if v_workflow_org_id is null and v_workflow_owner_id is null then
    raise exception 'workflow % not found', p_workflow_id;
  end if;

  if not private.can_write_workflow(p_workflow_id) then
    raise exception 'not authorized to act on workflow %', p_workflow_id;
  end if;

  select * into v_setup
  from public.agent_setups
  where workflow_id = p_workflow_id and source = 'platform' and unpublished_at is null;

  if v_setup.id is null then
    raise exception 'no published agent setup for workflow %', p_workflow_id;
  end if;

  if p_kind = 'run_now' and (p_payload ->> 'allowMassDelete')::boolean is true then
    if coalesce(v_setup.platform_job_state ->> 'state', '') <> 'paused'
       or coalesce(v_setup.platform_job_state ->> 'errorClass', '') <> 'massDelete' then
      raise exception 'setup for workflow % is not paused by the mass-delete guard', p_workflow_id;
    end if;
  end if;

  insert into public.agent_tasks (agent_id, agent_setup_id, kind, payload, expires_at)
  values (v_setup.agent_id, v_setup.id, p_kind, p_payload, now() + interval '1 hour')
  returning * into v_row;

  if v_workflow_org_id is not null then
    perform private.log_audit(
      v_workflow_org_id,
      'agent_setup.action_requested',
      jsonb_build_object('workflowId', p_workflow_id, 'kind', p_kind) || (p_payload - 'params')
    );
  else
    perform private.log_audit_personal(
      v_workflow_owner_id,
      'agent_setup.action_requested',
      jsonb_build_object('workflowId', p_workflow_id, 'kind', p_kind) || (p_payload - 'params')
    );
  end if;

  perform pg_notify('agent_setup_published', v_setup.agent_id::text);

  return v_row;
end;
$$;

revoke execute on function public.create_agent_setup_action_task(uuid, text, jsonb) from public, anon;
grant execute on function public.create_agent_setup_action_task(uuid, text, jsonb) to authenticated;
