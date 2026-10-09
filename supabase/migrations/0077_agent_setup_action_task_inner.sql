-- 0077_agent_setup_action_task_inner.sql
-- Agent-app Workflows screen needs agent-bridge (service-role, agent-key
-- auth — no auth.uid(), no user session at all) to create the exact same
-- run_now/pause/resume agent_tasks row the website's
-- create_agent_setup_action_task RPC creates, with the same guards (kind
-- allow-list, mass-delete-pause check) and the same pg_notify wakeup —
-- without being able to call a function gated by private.can_write_workflow
-- (auth.uid()-based, meaningless for a service-role caller acting on
-- behalf of an agent key rather than a logged-in user).
--
-- Splits the guard+insert+notify body out of the public RPC (0074/0076)
-- into a new private helper, scoped by (agent_id, workflow_id) instead of
-- trusting the caller to already know which agent owns the setup. The
-- public RPC becomes a thin wrapper: unchanged authorization
-- (can_write_workflow), unchanged error text/ordering for an unknown
-- workflow, unchanged audit-log call (same action name/detail, still
-- attributed to auth.uid()) — it only resolves which agent owns the
-- published setup, then delegates the guard+insert+notify to the helper.
-- The agent-bridge calls the helper directly, with service_role, passing
-- the already-authenticated agent's own id; ownership is enforced inside
-- the helper's own lookup (workflow_id + agent_id must both match one
-- row), so a bridge caller can never act on a workflow it isn't the
-- agent_id for. One source of truth for the guard+insert+notify logic —
-- the public RPC and the bridge both call the same function body.

create or replace function private.create_agent_setup_action_task(
  p_agent_id uuid,
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
  v_setup public.agent_setups;
  v_row public.agent_tasks;
begin
  if p_kind not in ('run_now', 'pause', 'resume', 'test_job') then
    raise exception 'unsupported action kind %', p_kind;
  end if;

  select * into v_setup
  from public.agent_setups
  where workflow_id = p_workflow_id
    and agent_id = p_agent_id
    and source = 'platform'
    and unpublished_at is null;

  if v_setup.id is null then
    raise exception 'no published agent setup for workflow % and agent %', p_workflow_id, p_agent_id;
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

  perform pg_notify('agent_setup_published', v_setup.agent_id::text);

  return v_row;
end;
$$;

-- Deliberately not granted to authenticated/anon: this helper trusts
-- p_agent_id outright (no auth.uid() check of its own) — it must only be
-- reachable from (a) the service-role agent-bridge, which has already
-- authenticated the caller via the agent key hash, and (b) the public RPC
-- below, which runs as its SECURITY DEFINER owner regardless of these
-- revokes and has already run can_write_workflow itself.
revoke execute on function private.create_agent_setup_action_task(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function private.create_agent_setup_action_task(uuid, uuid, text, jsonb) to service_role;

-- Thin wrapper: same signature, same authorization, same error text/
-- ordering, same audit-log call as before — only the guard+insert+notify
-- moved into the helper above.
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

  v_row := private.create_agent_setup_action_task(v_setup.agent_id, p_workflow_id, p_kind, p_payload);

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

  return v_row;
end;
$$;

revoke execute on function public.create_agent_setup_action_task(uuid, text, jsonb) from public, anon;
grant execute on function public.create_agent_setup_action_task(uuid, text, jsonb) to authenticated;
