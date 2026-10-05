-- 0074_agent_setup_actions.sql
-- Agent-Canvas integration, Slice R5a ("actions and run history for
-- agent-delivered workflows, platform and web side" — docs/plans/
-- agent-canvas-integration.md B.7/B.8).
--
-- Three additions, all additive (no existing column/constraint dropped):
--
--   1. public.agent_tasks gains four new kinds (run_now, pause, resume,
--      test_job) that act on a public.agent_setups row instead of a
--      public.connections row — 0072_agent_connections_tasks.sql's
--      connection_id NOT NULL and two-kind check are both widened rather
--      than replaced, so the existing test_connection/list_tables path
--      (services/agent-bridge/src/internalApp.ts) is untouched.
--   2. public.agent_setups gains platform_job_state, the source='platform'
--      counterpart to 0071's local_job_report — the agent's latest
--      reported state (ok/failing/paused, errorClass, lastRunAt,
--      nextRunAt, consecutiveFailures) for a platform-published job,
--      written by the bridge's check-in handler whenever a localJobs
--      entry carries a setupId (the wire contract apps/agent's concurrent
--      Slice R3b work already produces — see LocalJobReport.setupId).
--   3. public.create_agent_setup_action_task — the only way a real user
--      session creates one of the four new agent_tasks kinds, same
--      authorization posture as 0073's publish_agent_setup/
--      unpublish_agent_setup (private.can_write_workflow — any write
--      member, never a viewer). No HTTP hop to the bridge is needed: the
--      row lands straight in agent_tasks, and the bridge's own check-in
--      handler already queries agent_tasks fresh on every poll
--      (services/agent-bridge/src/app.ts's `transport.waitForTasks`), so
--      an offline or mid-hold agent still picks it up on its next
--      check-in exactly like a publish's wanted_version bump.

-- =========================================================================
-- 1. public.agent_tasks — new kinds, agent_setup_id, nullable connection_id
-- =========================================================================

alter table public.agent_tasks
  add column payload jsonb not null default '{}'::jsonb,
  add column agent_setup_id uuid references public.agent_setups (id) on delete cascade;

alter table public.agent_tasks
  alter column connection_id drop not null;

alter table public.agent_tasks
  drop constraint agent_tasks_kind_check;

alter table public.agent_tasks
  add constraint agent_tasks_kind_check
    check (kind in ('test_connection', 'list_tables', 'run_now', 'pause', 'resume', 'test_job'));

-- Exactly one of connection_id/agent_setup_id is set, matching which kind
-- family the row is: test_connection/list_tables act on a connection
-- (unchanged from 0072), the four new kinds act on a setup.
alter table public.agent_tasks
  add constraint agent_tasks_connection_xor_setup check (
    (kind in ('test_connection', 'list_tables') and connection_id is not null and agent_setup_id is null)
    or (kind in ('run_now', 'pause', 'resume', 'test_job') and agent_setup_id is not null and connection_id is null)
  );

create index agent_tasks_agent_setup_id_idx on public.agent_tasks (agent_setup_id);

comment on column public.agent_tasks.payload is
  'Kind-specific task body delivered to the agent on its next check-in '
  '(services/agent-bridge/src/app.ts). test_connection/list_tables '
  'carry {localConnectionId} here (unchanged from before this column '
  'existed, now just named explicitly instead of inferred). run_now '
  'carries {params?, fullReload?, allowMassDelete?}; pause/resume/'
  'test_job carry {}.';

comment on column public.agent_tasks.agent_setup_id is
  'The public.agent_setups row (source=''platform'') this action acts '
  'on, for kind in (run_now, pause, resume, test_job). Always NULL for '
  'test_connection/list_tables, which act on connection_id instead.';

-- Pre-existing rows (test_connection/list_tables) never had a payload
-- column before — backfill it from the column that already carried the
-- same information (connection_id), via the same localConnectionId the
-- bridge already resolves from a connections row. No historical rows
-- need this in practice (agent_tasks is pruned after 7 days —
-- services/agent-bridge/src/index.ts's cleanupFinishedTasks), but keeps
-- the default meaningful for any row that happens to survive the deploy.
update public.agent_tasks
  set payload = jsonb_build_object('connectionId', connection_id)
  where payload = '{}'::jsonb and connection_id is not null;

-- =========================================================================
-- 2. public.agent_setups.platform_job_state
-- =========================================================================

alter table public.agent_setups
  add column platform_job_state jsonb;

comment on column public.agent_setups.platform_job_state is
  'Live, check-in-reported state for a source=''platform'' row — same '
  'shape as 0071''s local_job_report (state: ok/failing/paused, '
  'errorClass, lastRunAt, nextRunAt, consecutiveFailures), written by '
  'the bridge when a localJobs entry carries this row''s id as its '
  'setupId (apps/agent''s SetupManager reports a platform-managed job '
  'through the same channel as a CLI-local one, just tagged). Always '
  'NULL for source=''local''. "Paused by the mass-delete guard" is '
  'state=''paused'' and errorClass=''massDelete'' (apps/agent/src/sync/'
  'keyReconciliation.ts''s RunSyncFailureKind convention).';

-- =========================================================================
-- 3. public.create_agent_setup_action_task
-- =========================================================================

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

  -- "allow one large delete" (run_now with payload.allowMassDelete = true)
  -- is accepted only while the agent's latest reported state is paused by
  -- the mass-delete guard specifically — never for any other pause/failing
  -- reason, and never without the explicit confirm flag the caller already
  -- turned into payload.allowMassDelete (apps/api's service layer, never
  -- this function, is what requires that flag be explicit from the user).
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
    perform private.log_audit(v_workflow_org_id, 'agent_setup.action_requested', jsonb_build_object('workflowId', p_workflow_id, 'kind', p_kind));
  else
    perform private.log_audit_personal(v_workflow_owner_id, 'agent_setup.action_requested', jsonb_build_object('workflowId', p_workflow_id, 'kind', p_kind));
  end if;

  perform pg_notify('agent_setup_published', v_setup.agent_id::text);

  return v_row;
end;
$$;

revoke execute on function public.create_agent_setup_action_task(uuid, text, jsonb) from public, anon;
grant execute on function public.create_agent_setup_action_task(uuid, text, jsonb) to authenticated;
