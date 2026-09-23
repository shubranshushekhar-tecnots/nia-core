-- 0031_copilot_agent.sql
-- Copilot agent (docs/plans/copilot-agent.md, Parts 1-3). Two new pieces:
--
-- 1. copilot_pending_actions — the confirmation mechanism an execute-tier
--    tool (start_run) must go through. A row is created by the acting
--    user's OWN client (plain insert, RLS-gated by can_access_workflow —
--    same pattern as copilot_applied_plans), carrying a hash of the exact
--    tool + arguments. confirmed_at/confirmed_by/consumed_at are settable
--    ONLY via the two SECURITY DEFINER rpcs below — never a plain client
--    UPDATE — so neither the agent loop nor anything an LLM could put into
--    a tool result can ever confirm or consume a pending action; only a
--    request that calls confirm_pending_action from the user's own
--    browser session can. Expires after 10 minutes (checked in both rpcs,
--    not just at read time).
--
-- 2. log_copilot_tool_call — the audit event required for every tool call
--    (read, edit, or execute), source: 'copilot'. A single generic rpc
--    (mirroring private.log_audit/log_audit_personal's own org/owner
--    split) rather than one rpc per tool, since every call shares the same
--    shape (tool, tier, workflow, summary). Calls the existing
--    private.log_audit/log_audit_personal functions internally — those are
--    revoked from authenticated (0001/0007) but callable from another
--    SECURITY DEFINER function owned by the same role, the same way
--    create_organization already does.

create table public.copilot_pending_actions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  tool text not null,
  -- Canonical-JSON sha256 of the exact tool arguments (computed in
  -- apps/api, never trusted from the client past this hash match) — see
  -- Part 3: "a hash of the exact arguments... refuses to execute without
  -- a confirmed pending action whose hash matches the arguments."
  args_hash text not null,
  -- The arguments themselves, stored so the confirm-endpoint's UI renderer
  -- can re-derive real data (source/destination names, write mode) from
  -- the database using these ids — never from text the model wrote.
  args jsonb not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  confirmed_at timestamptz,
  confirmed_by uuid,
  consumed_at timestamptz
);

create index copilot_pending_actions_workflow_id_idx
  on public.copilot_pending_actions (workflow_id, created_at desc);

alter table public.copilot_pending_actions enable row level security;

create policy "copilot_pending_actions_select_access"
  on public.copilot_pending_actions for select
  using (private.can_access_workflow(workflow_id));

create policy "copilot_pending_actions_insert_access"
  on public.copilot_pending_actions for insert
  with check (private.can_access_workflow(workflow_id) and created_by = auth.uid());

-- No update/delete grant — confirmed_at/confirmed_by/consumed_at are only
-- ever set by the two rpcs below, same "must never happen without going
-- through the dedicated path" reasoning as copilot_applied_plans'
-- reverted_at columns.
grant select, insert on public.copilot_pending_actions to authenticated;

-- =========================================================================
-- confirm_pending_action — the ONLY way confirmed_at/confirmed_by get set.
-- Called exclusively by the user-session confirm endpoint (never by the
-- agent loop) — see apps/api/src/routes/copilotAgent.ts. A no-op-turned-
-- exception on anything already confirmed/consumed or past its expiry, so
-- a stale confirm click fails loud rather than silently re-confirming.
-- =========================================================================

create or replace function public.confirm_pending_action(p_id uuid)
returns public.copilot_pending_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_id uuid;
  v_row public.copilot_pending_actions;
begin
  select workflow_id into v_workflow_id
  from public.copilot_pending_actions
  where id = p_id;

  if v_workflow_id is null then
    raise exception 'pending action % not found', p_id;
  end if;

  if not private.can_access_workflow(v_workflow_id) then
    raise exception 'not authorized for workflow %', v_workflow_id;
  end if;

  update public.copilot_pending_actions
    set confirmed_at = now(), confirmed_by = auth.uid()
    where id = p_id
      and confirmed_at is null
      and consumed_at is null
      and expires_at > now()
    returning * into v_row;

  if v_row.id is null then
    raise exception 'pending action % cannot be confirmed (already confirmed, consumed, or expired)', p_id;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.confirm_pending_action(uuid) from public, anon;
grant execute on function public.confirm_pending_action(uuid) to authenticated;

-- =========================================================================
-- consume_pending_action — the ONLY way consumed_at gets set. Called from
-- the start_run tool handler itself, right before it starts the run, with
-- the tool name and args hash it is about to execute — the arguments-match
-- guard is what stops a confirmed pending action from being replayed
-- against different arguments than the ones the user actually confirmed.
-- =========================================================================

create or replace function public.consume_pending_action(p_id uuid, p_tool text, p_args_hash text)
returns public.copilot_pending_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_id uuid;
  v_row public.copilot_pending_actions;
begin
  select workflow_id into v_workflow_id
  from public.copilot_pending_actions
  where id = p_id;

  if v_workflow_id is null then
    raise exception 'pending action % not found', p_id;
  end if;

  if not private.can_access_workflow(v_workflow_id) then
    raise exception 'not authorized for workflow %', v_workflow_id;
  end if;

  update public.copilot_pending_actions
    set consumed_at = now()
    where id = p_id
      and tool = p_tool
      and args_hash = p_args_hash
      and confirmed_at is not null
      and consumed_at is null
      and expires_at > now()
    returning * into v_row;

  if v_row.id is null then
    raise exception 'pending action % is not confirmed, already consumed, expired, or its arguments no longer match', p_id;
  end if;

  return v_row;
end;
$$;

revoke execute on function public.consume_pending_action(uuid, text, text) from public, anon;
grant execute on function public.consume_pending_action(uuid, text, text) to authenticated;

-- =========================================================================
-- log_copilot_tool_call — audit event for every Copilot tool call (read,
-- edit, or execute alike), source: 'copilot'. Throws (never best-effort)
-- on failure, per CONVENTIONS.md's "audit log is load-bearing" doctrine.
-- =========================================================================

create or replace function public.log_copilot_tool_call(
  p_org_id uuid,
  p_owner_id uuid,
  p_tool text,
  p_tier text,
  p_workflow_id uuid,
  p_summary text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org_id is not null then
    perform private.log_audit(
      p_org_id,
      'copilot_tool.' || p_tool,
      jsonb_build_object('tool', p_tool, 'tier', p_tier, 'workflowId', p_workflow_id, 'summary', p_summary, 'source', 'copilot')
    );
  elsif p_owner_id is not null then
    perform private.log_audit_personal(
      p_owner_id,
      'copilot_tool.' || p_tool,
      jsonb_build_object('tool', p_tool, 'tier', p_tier, 'workflowId', p_workflow_id, 'summary', p_summary, 'source', 'copilot')
    );
  else
    raise exception 'log_copilot_tool_call requires either an org id or an owner id';
  end if;
end;
$$;

revoke execute on function public.log_copilot_tool_call(uuid, uuid, text, text, uuid, text) from public, anon;
grant execute on function public.log_copilot_tool_call(uuid, uuid, text, text, uuid, text) to authenticated;
