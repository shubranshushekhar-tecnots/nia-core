-- 0073_agent_setup_publish.sql
-- Agent-Canvas integration, Slice R3a ("publishing a job to an agent,
-- platform side" — docs/plans/agent-canvas-integration.md B.2/B.4/B.7).
--
-- 0071_agent_setups.sql's header comment explicitly reserved this: "Route
-- 2 ... not built yet — these columns exist now so Route 2 only has to
-- add columns later, never touch RLS/shape". This migration is that
-- addition: four new columns on the existing public.agent_setups row
-- (never a new table), plus the two SECURITY DEFINER RPCs that are the
-- only way those columns are ever written from a real user session.
--
-- published_setup/published_by_user_id/published_at: the published
-- packages/schemas AgentJobSetup (jsonb, validated by the caller before
-- this RPC ever sees it — this migration does not re-validate the
-- payload's own shape, only the publish/unpublish authorization and the
-- source/destination/agent business rules below), who published it, and
-- when. unpublished_at: a distinct removed-marker from 0071's own
-- removed_at (which is local-job-only, per that column's own comment) —
-- kept separate so "a CLI job the agent stopped reporting" and "a
-- platform job a member unpublished" are never conflated even though
-- both end up soft-removed, not deleted (run history survives either
-- way, same discipline as 0071).
--
-- wanted_version (0071) already exists and already means exactly what
-- B.4 needs here: every successful publish OR unpublish bumps it, so the
-- bridge's wanted-vs-applied comparison on the agent's next check-in
-- (not a one-off task — B.4's explicit requirement, "so nothing is lost
-- while an agent is offline") picks up the change whenever the agent
-- next asks, with no new column needed for that half of the model.
--
-- No secrets anywhere in published_setup — packages/schemas'
-- AgentJobSetup (packages/schemas/src/agentJobSetup.ts) carries none by
-- construction; the destination's own vault_secret_ref (already on
-- public.connections since 0007) is the only path to that secret, same
-- as every other connection in this schema.

-- =========================================================================
-- 1. New columns on public.agent_setups
-- =========================================================================

alter table public.agent_setups
  add column published_setup jsonb,
  add column published_by_user_id uuid references public."user" (id),
  add column published_at timestamptz,
  add column unpublished_at timestamptz;

comment on column public.agent_setups.published_setup is
  'The published packages/schemas AgentJobSetup (jsonb) for a '
  'source=''platform'' row — no secrets (see agentJobSetup.ts''s own '
  'header comment). Always NULL for source=''local''.';

comment on column public.agent_setups.published_by_user_id is
  'The member who last called publish_agent_setup for this row. Always '
  'NULL for source=''local''.';

comment on column public.agent_setups.unpublished_at is
  'Set by unpublish_agent_setup — distinct from 0071''s removed_at '
  '(local-job-only: "the agent stops reporting this local_job_id"). '
  'Cleared back to NULL by a subsequent publish_agent_setup call. Only '
  'ever set for source=''platform'' rows.';

-- One platform setup per workflow — lets publish_agent_setup upsert via
-- `on conflict (workflow_id)` instead of a separate select-then-branch.
-- Partial (workflow_id is not null) so it coexists with 0071's existing
-- non-unique agent_setups_workflow_id_idx and never constrains
-- source='local' rows (workflow_id always null there).
create unique index agent_setups_workflow_id_unique
  on public.agent_setups (workflow_id)
  where workflow_id is not null;

-- =========================================================================
-- 2. private.can_write_workflow(p_workflow) — the same "write member (not
--    viewer), admin or project member, or personal owner" rule as
--    workflows_update_members (0057_viewer_role_restrictions.sql), as a
--    reusable helper rather than re-inlining the workflows join in both
--    RPCs below.
-- =========================================================================

create or replace function private.can_write_workflow(p_workflow uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workflows w
    where w.id = p_workflow
      and (
        (w.org_id is not null and private.is_write_member(w.org_id) and not private.is_org_suspended(w.org_id) and (private.is_admin(w.org_id) or private.is_project_member(w.project_id)))
        or (w.org_id is null and w.owner_id = auth.uid())
      )
  );
$$;

revoke execute on function private.can_write_workflow(uuid) from public, anon, authenticated;
grant execute on function private.can_write_workflow(uuid) to authenticated;

-- =========================================================================
-- 3. publish_agent_setup — any write member with access to the workflow
--    (never a viewer, enforced by can_write_workflow above), refused
--    unless the source is a local-database-via-agent connection and the
--    destination is a Planometry table or HTTPS endpoint connection, both
--    in the same organisation or workspace as the workflow, on an active
--    agent.
-- =========================================================================

create or replace function public.publish_agent_setup(
  p_workflow_id uuid,
  p_source_connection_id uuid,
  p_destination_connection_id uuid,
  p_setup jsonb
)
returns public.agent_setups
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_org_id uuid;
  v_workflow_owner_id uuid;
  v_source_org_id uuid;
  v_source_owner_id uuid;
  v_source_connector_id text;
  v_source_config jsonb;
  v_dest_org_id uuid;
  v_dest_owner_id uuid;
  v_dest_connector_id text;
  v_agent_id uuid;
  v_agent_org_id uuid;
  v_agent_owner_id uuid;
  v_agent_status public.platform_agent_status;
  v_row public.agent_setups;
begin
  select org_id, owner_id into v_workflow_org_id, v_workflow_owner_id
  from public.workflows where id = p_workflow_id;

  if v_workflow_org_id is null and v_workflow_owner_id is null then
    raise exception 'workflow % not found', p_workflow_id;
  end if;

  if not private.can_write_workflow(p_workflow_id) then
    raise exception 'not authorized to publish workflow %', p_workflow_id;
  end if;

  select org_id, owner_id, connector_id, config
    into v_source_org_id, v_source_owner_id, v_source_connector_id, v_source_config
    from public.connections where id = p_source_connection_id;

  if v_source_connector_id is null then
    raise exception 'source connection % not found', p_source_connection_id;
  end if;

  if v_source_connector_id <> 'sqlserver-agent' then
    raise exception 'source connection % is not a local database connection', p_source_connection_id;
  end if;

  if not (
    (v_workflow_org_id is not null and v_source_org_id = v_workflow_org_id)
    or (v_workflow_owner_id is not null and v_source_owner_id = v_workflow_owner_id)
  ) then
    raise exception 'source connection % is not in the same organisation or workspace as workflow %', p_source_connection_id, p_workflow_id;
  end if;

  select org_id, owner_id, connector_id
    into v_dest_org_id, v_dest_owner_id, v_dest_connector_id
    from public.connections where id = p_destination_connection_id;

  if v_dest_connector_id is null then
    raise exception 'destination connection % not found', p_destination_connection_id;
  end if;

  if v_dest_connector_id not in ('planometry-table', 'https-endpoint') then
    raise exception 'destination connection % is not a supported publish destination', p_destination_connection_id;
  end if;

  if not (
    (v_workflow_org_id is not null and v_dest_org_id = v_workflow_org_id)
    or (v_workflow_owner_id is not null and v_dest_owner_id = v_workflow_owner_id)
  ) then
    raise exception 'destination connection % is not in the same organisation or workspace as workflow %', p_destination_connection_id, p_workflow_id;
  end if;

  v_agent_id := (v_source_config ->> 'agentId')::uuid;
  if v_agent_id is null then
    raise exception 'source connection % has no agent configured', p_source_connection_id;
  end if;

  select org_id, owner_id, status into v_agent_org_id, v_agent_owner_id, v_agent_status
    from public.platform_agents where id = v_agent_id;

  if v_agent_status is null then
    raise exception 'agent % not found', v_agent_id;
  end if;

  if v_agent_status <> 'active' then
    raise exception 'agent % is not active', v_agent_id;
  end if;

  if not (
    (v_workflow_org_id is not null and v_agent_org_id = v_workflow_org_id)
    or (v_workflow_owner_id is not null and v_agent_owner_id = v_workflow_owner_id)
  ) then
    raise exception 'agent % is not in the same organisation or workspace as workflow %', v_agent_id, p_workflow_id;
  end if;

  insert into public.agent_setups (
    workflow_id, source, agent_id, connection_id, destination_connection_id,
    wanted_version, published_setup, published_by_user_id, published_at, unpublished_at
  )
  values (
    p_workflow_id, 'platform', v_agent_id, p_source_connection_id, p_destination_connection_id,
    1, p_setup, auth.uid(), now(), null
  )
  on conflict (workflow_id) where workflow_id is not null do update set
    agent_id = excluded.agent_id,
    connection_id = excluded.connection_id,
    destination_connection_id = excluded.destination_connection_id,
    wanted_version = public.agent_setups.wanted_version + 1,
    published_setup = excluded.published_setup,
    published_by_user_id = excluded.published_by_user_id,
    published_at = excluded.published_at,
    unpublished_at = null,
    updated_at = now()
  returning * into v_row;

  if v_workflow_org_id is not null then
    perform private.log_audit(v_workflow_org_id, 'agent_setup.published', jsonb_build_object('workflowId', p_workflow_id, 'agentId', v_agent_id));
  else
    perform private.log_audit_personal(v_workflow_owner_id, 'agent_setup.published', jsonb_build_object('workflowId', p_workflow_id, 'agentId', v_agent_id));
  end if;

  perform pg_notify('agent_setup_published', v_agent_id::text);

  return v_row;
end;
$$;

revoke execute on function public.publish_agent_setup(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.publish_agent_setup(uuid, uuid, uuid, jsonb) to authenticated;

-- =========================================================================
-- 4. unpublish_agent_setup — same authorization as publish. Marks the
--    setup removed (unpublished_at) rather than deleting the row, so
--    agent_setup_runs history survives (same discipline as 0071's own
--    removed_at for local jobs).
-- =========================================================================

create or replace function public.unpublish_agent_setup(p_workflow_id uuid)
returns public.agent_setups
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_org_id uuid;
  v_workflow_owner_id uuid;
  v_row public.agent_setups;
begin
  select org_id, owner_id into v_workflow_org_id, v_workflow_owner_id
  from public.workflows where id = p_workflow_id;

  if v_workflow_org_id is null and v_workflow_owner_id is null then
    raise exception 'workflow % not found', p_workflow_id;
  end if;

  if not private.can_write_workflow(p_workflow_id) then
    raise exception 'not authorized to unpublish workflow %', p_workflow_id;
  end if;

  update public.agent_setups
    set unpublished_at = now(),
        wanted_version = wanted_version + 1,
        updated_at = now()
    where workflow_id = p_workflow_id and source = 'platform'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'no published setup found for workflow %', p_workflow_id;
  end if;

  if v_workflow_org_id is not null then
    perform private.log_audit(v_workflow_org_id, 'agent_setup.unpublished', jsonb_build_object('workflowId', p_workflow_id, 'agentId', v_row.agent_id));
  else
    perform private.log_audit_personal(v_workflow_owner_id, 'agent_setup.unpublished', jsonb_build_object('workflowId', p_workflow_id, 'agentId', v_row.agent_id));
  end if;

  perform pg_notify('agent_setup_published', v_row.agent_id::text);

  return v_row;
end;
$$;

revoke execute on function public.unpublish_agent_setup(uuid) from public, anon;
grant execute on function public.unpublish_agent_setup(uuid) to authenticated;
