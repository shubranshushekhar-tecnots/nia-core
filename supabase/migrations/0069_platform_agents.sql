-- 0069_platform_agents.sql
-- Agent-Canvas integration, Slice 1 ("Link") — platform side.
-- docs/plans/agent-canvas-integration.md B.1 (permissions), B.2 (data
-- model, tables 1-2 of 6), B.12 (pairing and keys).
--
-- Two tables, scoped like public.connections (org_id/owner_id xor — a
-- personal workspace's agents are owner_id-scoped exactly like a personal
-- connection, same as every other "scoped like connections" table since
-- 0005_individual_workspace.sql):
--
--   1. platform_agents — the paired agent registry. Created only by
--      consume_agent_pairing_code (below), called from the agent-bridge's
--      service-role connection (services/agent-bridge) — never a direct
--      client insert, since pairing has no "acting user" (the agent
--      presents a one-time code, not a session). Mutated only by
--      revoke_agent, called by a real member's session. "online"/"offline"
--      is a derived read (last_check_in_at vs. a threshold), computed in
--      apps/api's service layer — not a stored column here.
--   2. agent_pairing_codes — one-time pairing codes (B.12): 8-character
--      codes, 15-minute expiry, 5 attempts before lockout. Created via
--      create_agent_pairing_code by any write member (private.is_write_member
--      — same "any member, not viewers" gate as connections/projects/
--      workflows since 0057_viewer_role_restrictions.sql), consumed via
--      consume_agent_pairing_code from the bridge's service-role connection.
--
-- Hash-only storage, same discipline as invite_links.token_hash
-- (0058_invite_links.sql): the raw pairing code and the raw agent key are
-- both generated and hashed in Node (services/agent-bridge), never in
-- Postgres — only code_hash/agent_key_hash are ever stored, and
-- consume_agent_pairing_code takes an already-hashed p_code_hash to
-- compare, never the raw code. Looking a pairing code row up by its own
-- id (non-secret) rather than by code_hash is what lets wrong attempts be
-- counted per-row without that lookup itself being a guessable oracle —
-- the bridge's /agent-api/pair request carries {pairingCodeId, code}, not
-- just {code}.
--
-- created_by_user_id/owner_id reference public."user"(id), not
-- auth.users(id) — per 0068_llm_usage.sql, public."user" is the live
-- identity table post-Better-Auth-cutover (0035_better_auth.sql).
--
-- Agents not yet an existing table family, so platform_agent_status is a
-- brand new enum (own transaction below, before any column uses it, per
-- Postgres's add-then-use rule for enums within one migration file: this
-- repo's migrate.mjs runs each file as one statement-by-statement session,
-- not necessarily one transaction per `create type`, so the type is
-- created first, then used — same ordering 0002/0010/0067 already use).

-- =========================================================================
-- 1. platform_agent_status enum
-- =========================================================================

create type public.platform_agent_status as enum ('pending', 'active', 'revoked');

-- =========================================================================
-- 2. platform_agents
-- =========================================================================

create table public.platform_agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid references public."user" (id),
  created_by_user_id uuid not null references public."user" (id),
  display_name text not null,
  agent_key_hash text not null unique,
  status public.platform_agent_status not null,
  agent_version text,
  host_name text,
  last_check_in_at timestamptz,
  created_at timestamptz not null default now(),
  constraint platform_agents_org_xor_owner check (
    (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
  )
);

create index platform_agents_org_id_idx on public.platform_agents (org_id);
create index platform_agents_owner_id_idx on public.platform_agents (owner_id);

comment on column public.platform_agents.agent_key_hash is
  'SHA-256 hex digest of the agent''s long-lived API key. The raw key is '
  'never stored — it is returned once, in consume_agent_pairing_code''s '
  'caller (services/agent-bridge)''s /agent-api/pair response.';

comment on column public.platform_agents.created_by_user_id is
  'The member who paired this agent (agent_pairing_codes.created_by_user_id '
  'at the moment the code was consumed). Used by private.can_manage_agent '
  'as one of the three roles allowed to revoke it (B.1).';

alter table public.platform_agents enable row level security;

-- Read: any member or viewer (private.is_member includes viewer) — same
-- posture as connections_select_members. No insert/update/delete policy:
-- rows are only ever written by consume_agent_pairing_code/revoke_agent
-- below, both SECURITY DEFINER (run as table owner, bypass RLS and the
-- grant layer entirely) — direct client writes have no grant at all, let
-- alone a policy.
create policy "platform_agents_select_members"
  on public.platform_agents for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

grant select on public.platform_agents to authenticated;

-- =========================================================================
-- 3. agent_pairing_codes
-- =========================================================================

create table public.agent_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  owner_id uuid references public."user" (id),
  created_by_user_id uuid not null references public."user" (id),
  code_hash text not null unique,
  expires_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  used_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_pairing_codes_org_xor_owner check (
    (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
  )
);

create index agent_pairing_codes_org_id_idx on public.agent_pairing_codes (org_id);
create index agent_pairing_codes_owner_id_idx on public.agent_pairing_codes (owner_id);

comment on column public.agent_pairing_codes.code_hash is
  'SHA-256 hex digest of the 8-character pairing code shown once on the '
  'Agents page. The raw code is generated and hashed in Node '
  '(apps/api/src/services/agents.ts), never in Postgres.';

comment on column public.agent_pairing_codes.locked_at is
  'Set once attempt_count reaches max_attempts (5) — distinct from '
  'used_at (a successful pair). A locked or used code can never be '
  'consumed again; a new one must be issued.';

alter table public.agent_pairing_codes enable row level security;

-- RPC-only, zero grant to authenticated/anon — same posture as
-- invite_links (0058): create_agent_pairing_code/consume_agent_pairing_code
-- (both SECURITY DEFINER, below) are the only path in or out. No select
-- policy either — the create RPC returns the newly created row directly
-- to its caller, and nothing else ever needs to list pairing codes in
-- this slice.

-- =========================================================================
-- 4. private.can_manage_agent(p_agent_id) — admin/owner of the agent's
--    org, OR the personal owner (individual workspace), OR the specific
--    member who paired it (B.1). Mirrors private.can_manage_project's
--    shape (0054_project_members.sql) plus the pairing-member branch.
-- =========================================================================

create or replace function private.can_manage_agent(p_agent_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_agents a
    where a.id = p_agent_id
      and (
        (a.org_id is not null and private.is_admin(a.org_id))
        or (a.org_id is null and a.owner_id = auth.uid())
        or a.created_by_user_id = auth.uid()
      )
  );
$$;

-- Not used inside any RLS policy directly (only inside revoke_agent below,
-- which runs as the function owner regardless of grants) — revoked from
-- everyone, including authenticated, same defense-in-depth posture as
-- private.log_audit.
revoke execute on function private.can_manage_agent(uuid) from public, anon, authenticated;

-- =========================================================================
-- 5. create_agent_pairing_code — any write member (not viewer) for an
--    org, or the personal owner for an individual workspace (B.1).
-- =========================================================================

create or replace function public.create_agent_pairing_code(
  p_org_id uuid,
  p_owner_id uuid,
  p_code_hash text
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

  insert into public.agent_pairing_codes (org_id, owner_id, created_by_user_id, code_hash, expires_at)
  values (p_org_id, p_owner_id, auth.uid(), p_code_hash, now() + interval '15 minutes')
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_agent_pairing_code(uuid, uuid, text) from public, anon;
grant execute on function public.create_agent_pairing_code(uuid, uuid, text) to authenticated;

-- =========================================================================
-- 6. consume_agent_pairing_code — called only from services/agent-bridge's
--    withServiceRole connection (no acting user: the agent authenticates
--    with the one-time code, not a session). Looks the code up by its own
--    id (non-secret), compares an already-hashed code against code_hash,
--    and atomically tracks wrong attempts up to the lockout. Row-locked
--    (SELECT ... FOR UPDATE) for the duration so two concurrent guesses
--    against the same code can't both slip past the attempt-count check.
--
--    Returns a status column instead of raising for any of the
--    "ordinary" refusal outcomes (not_found/locked/used/expired/
--    incorrect), unlike every other RPC in this migration — deliberately,
--    because withServiceRole/withActingUser each run one RPC call as its
--    own single BEGIN/COMMIT (packages/db/src/client.ts's withTransaction):
--    a RAISE EXCEPTION aborts that whole transaction, which would silently
--    roll back the very attempt_count/locked_at UPDATE below that's
--    supposed to persist the wrong guess. Returning normally lets that
--    UPDATE commit every time, including on the attempt that trips the
--    lockout; the bridge (services/agent-bridge/src/app.ts) maps `status`
--    to its own 401 response.
-- =========================================================================

create or replace function public.consume_agent_pairing_code(
  p_pairing_code_id uuid,
  p_code_hash text
)
returns table (
  status text,
  org_id uuid,
  owner_id uuid,
  created_by_user_id uuid
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
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_row.locked_at is not null then
    return query select 'locked'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id;
    return;
  end if;

  if v_row.used_at is not null then
    return query select 'used'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id;
    return;
  end if;

  if v_row.expires_at <= now() then
    return query select 'expired'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id;
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
      v_row.org_id, v_row.owner_id, v_row.created_by_user_id;
    return;
  end if;

  update public.agent_pairing_codes
    set used_at = now()
    where id = p_pairing_code_id and used_at is null
    returning * into v_row;

  return query select 'ok'::text, v_row.org_id, v_row.owner_id, v_row.created_by_user_id;
end;
$$;

revoke execute on function public.consume_agent_pairing_code(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_agent_pairing_code(uuid, text) to service_role;

-- =========================================================================
-- 7. revoke_agent — admins, owners, and the pairing member (B.1/B.12).
--    Soft-delete only (status -> revoked); every subsequent check-in is
--    rejected by the bridge (platform_agents.status <> 'revoked' check).
-- =========================================================================

create or replace function public.revoke_agent(p_agent_id uuid)
returns public.platform_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.platform_agents;
begin
  if not private.can_manage_agent(p_agent_id) then
    raise exception 'not authorized for agent %', p_agent_id;
  end if;

  update public.platform_agents
    set status = 'revoked'
    where id = p_agent_id and status <> 'revoked'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'agent % not found or already revoked', p_agent_id;
  end if;

  if v_row.org_id is not null then
    perform private.log_audit(v_row.org_id, 'agent.revoked', jsonb_build_object('agentId', p_agent_id));
  else
    perform private.log_audit_personal(v_row.owner_id, 'agent.revoked', jsonb_build_object('agentId', p_agent_id));
  end if;

  return v_row;
end;
$$;

revoke execute on function public.revoke_agent(uuid) from public, anon;
grant execute on function public.revoke_agent(uuid) to authenticated;
