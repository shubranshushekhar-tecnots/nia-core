-- 0070_agent_pairing_code_name.sql
-- Agent-Canvas integration, Slice L3 follow-up — persist the agent name
-- the user types into AddAgentDialog (apps/web) instead of discarding it.
--
-- 0069_platform_agents.sql's create_agent_pairing_code had no way to carry
-- a caller-supplied name through to the agent record created later by
-- consume_agent_pairing_code (called from services/agent-bridge's
-- service-role connection, which has no access to the web request that
-- created the code) — the bridge's /pair handler used a hardcoded
-- `Agent paired <timestamp>` display_name instead. This migration adds
-- the missing column and threads it through both RPCs.
--
-- Nullable (migration compatibility rule, DEPLOYMENT.md): an
-- agent_pairing_codes row created by old app code (no p_display_name arg)
-- must remain valid during a rolling deploy, so the column has no NOT
-- NULL constraint. The bridge falls back to the old hardcoded string when
-- consume_agent_pairing_code returns a null display_name — see
-- services/agent-bridge/src/app.ts.

alter table public.agent_pairing_codes
  add column display_name text;

comment on column public.agent_pairing_codes.display_name is
  'Name the user typed into AddAgentDialog when creating this pairing '
  'code (apps/web/src/lib/agents/actions.ts). Copied onto the resulting '
  'platform_agents row by consume_agent_pairing_code/the bridge''s /pair '
  'handler. Null for codes created before this column existed, or if no '
  'name was given — the bridge falls back to a timestamp-based name.';

-- =========================================================================
-- create_agent_pairing_code — add p_display_name, default null so existing
-- callers (none outside this repo) keep working unchanged.
-- =========================================================================

create or replace function public.create_agent_pairing_code(
  p_org_id uuid,
  p_owner_id uuid,
  p_code_hash text,
  p_display_name text default null
)
returns public.agent_pairing_codes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_pairing_codes;
begin
  if (p_org_id is null) = (p_owner_id is null) then
    raise exception 'exactly one of p_org_id/p_owner_id must be set';
  end if;

  if p_org_id is not null and not private.is_write_member(p_org_id) then
    raise exception 'not authorized to pair an agent for org %', p_org_id;
  end if;

  if p_owner_id is not null and p_owner_id <> auth.uid() then
    raise exception 'not authorized to pair an agent for this workspace';
  end if;

  insert into public.agent_pairing_codes (org_id, owner_id, created_by_user_id, code_hash, display_name, expires_at)
  values (p_org_id, p_owner_id, auth.uid(), p_code_hash, p_display_name, now() + interval '15 minutes')
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_agent_pairing_code(uuid, uuid, text, text) from public, anon;
grant execute on function public.create_agent_pairing_code(uuid, uuid, text, text) to authenticated;

-- Old 3-arg overload is gone the moment create or replace above runs under
-- a different signature (Postgres treats them as distinct functions) —
-- drop it explicitly so it's not left behind as dead, uncallable code.
drop function if exists public.create_agent_pairing_code(uuid, uuid, text);

-- =========================================================================
-- consume_agent_pairing_code — return display_name alongside the existing
-- columns so the bridge can use it when inserting the platform_agents row.
-- =========================================================================

-- Postgres refuses `create or replace` across a changed return-table shape
-- (the new display_name output column) — drop the old 4-column-returning
-- version explicitly first.
drop function if exists public.consume_agent_pairing_code(uuid, text);

create or replace function public.consume_agent_pairing_code(
  p_pairing_code_id uuid,
  p_code_hash text
)
returns table (
  status text,
  org_id uuid,
  owner_id uuid,
  created_by_user_id uuid,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_pairing_codes;
begin
  select * into v_row from public.agent_pairing_codes where id = p_pairing_code_id for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v_row.locked_at is not null then
    return query select 'locked'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id, v_row.display_name;
    return;
  end if;

  if v_row.used_at is not null then
    return query select 'used'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id, v_row.display_name;
    return;
  end if;

  if v_row.expires_at <= now() then
    return query select 'expired'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id, v_row.display_name;
    return;
  end if;

  if v_row.code_hash <> p_code_hash then
    update public.agent_pairing_codes
      set attempt_count = attempt_count + 1,
          locked_at = case when attempt_count + 1 >= max_attempts then now() else null end
      where id = p_pairing_code_id
      returning * into v_row;
    return query select
      (case when v_row.locked_at is not null then 'locked' else 'incorrect' end)::text,
      v_row.org_id, v_row.owner_id, v_row.created_by_user_id, v_row.display_name;
    return;
  end if;

  update public.agent_pairing_codes
    set used_at = now()
    where id = p_pairing_code_id and used_at is null
    returning * into v_row;

  return query select 'ok'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id, v_row.display_name;
end;
$$;

revoke execute on function public.consume_agent_pairing_code(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_agent_pairing_code(uuid, text) to service_role;
