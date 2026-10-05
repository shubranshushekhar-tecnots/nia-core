-- 0072_agent_connections_tasks.sql
-- Agent-Canvas integration, Slice "Connection" (C1) — docs/plans/
-- agent-canvas-integration.md B.2/B.3/B.5/B.6: a platform connection can
-- now point at a database only a paired desktop agent can reach.
--
-- Two tables, both written only by the bridge's withServiceRole connection
-- (same posture as agent_setups/agent_setup_runs, 0071's header) — no RPC,
-- no direct client insert/update/delete grant:
--
--   1. agent_reported_connections — one row per local connection the agent
--      currently has configured (name/database/dialect only, reported on
--      every check-in — never host/user/password, same discipline as
--      agent_setups.local_job_report for CLI jobs). Soft-removed
--      (removed_at) when the agent stops reporting it, same pattern as
--      agent_setups' local jobs.
--   2. agent_tasks — one row per test_connection/list_tables request the
--      bridge's internal listener (/test, /introspect) creates for an
--      agent, delivered to the agent over the existing check-in long-poll
--      and resolved by the agent's own POST to /agent-api/task-results.
--      Service-role-only end to end (no client ever reads/writes this
--      table directly — results surface through the dispatch call itself,
--      not through a select), so RLS is enabled with zero policies, same
--      posture as agent_pairing_codes (0069: "RPC-only, zero grant").

-- =========================================================================
-- 1. agent_reported_connections
-- =========================================================================

create table public.agent_reported_connections (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.platform_agents (id) on delete cascade,
  local_connection_id text not null,
  name text not null,
  database_name text not null,
  dialect text not null,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint agent_reported_connections_agent_local_unique unique (agent_id, local_connection_id)
);

create index agent_reported_connections_agent_id_idx on public.agent_reported_connections (agent_id);

comment on column public.agent_reported_connections.local_connection_id is
  'The agent-local connection id (apps/agent/src/cli/connectionCommands.ts''s '
  'own id, from its local encrypted store) — opaque to the platform, never '
  'a platform connections.id.';

comment on column public.agent_reported_connections.removed_at is
  'Set when the agent stops reporting this local_connection_id on check-in '
  '(removed from its local config) — soft-removed, not deleted, so any '
  'platform connection already pointing at it can still show a clear '
  '"no longer reported" state instead of losing its row. Cleared back to '
  'NULL if the same local_connection_id is reported again.';

alter table public.agent_reported_connections enable row level security;

-- Same fallback as agent_setups' source='local' branch (0071) — plain
-- membership on the agent's org/personal workspace, no new RLS pattern.
create policy "agent_reported_connections_select_members"
  on public.agent_reported_connections for select
  using (
    exists (
      select 1 from public.platform_agents a
      where a.id = agent_reported_connections.agent_id
        and (
          (a.org_id is not null and private.is_member(a.org_id))
          or (a.org_id is null and a.owner_id = auth.uid())
        )
    )
  );

grant select on public.agent_reported_connections to authenticated;

-- =========================================================================
-- 2. agent_tasks
-- =========================================================================

create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.platform_agents (id) on delete cascade,
  connection_id uuid not null references public.connections (id) on delete cascade,
  kind text not null check (kind in ('test_connection', 'list_tables')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'done', 'failed')),
  result jsonb,
  error_class text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  expires_at timestamptz not null,
  completed_at timestamptz
);

create index agent_tasks_agent_id_status_idx on public.agent_tasks (agent_id, status);

comment on column public.agent_tasks.connection_id is
  'The platform connections.id this task is for — the one id the caller '
  '(apps/api) already trusts. The bridge resolves agent_id/local_connection_id '
  'itself from this row and connections.config at task-creation time '
  '(services/agent-bridge/src/app.ts), never from values the request body '
  'carries, so a stale/tampered body config can never widen access.';

comment on column public.agent_tasks.expires_at is
  'Set to now() + the route''s own per-kind timeout (test_connection 8s, '
  'list_tables 10s — both strictly shorter than apps/api''s 15s dispatch '
  'timeout) at creation time. A task not resolved by then fails as a '
  'transient error; it is never left pending indefinitely.';

-- Service-role-only, no client access at all (not even select) — the
-- bridge is the only reader/writer, and results reach apps/api through
-- the /test or /introspect response itself, never a client-side select on
-- this table. Same posture as agent_pairing_codes (0069).
alter table public.agent_tasks enable row level security;
