-- 0071_agent_setups.sql
-- Agent-Canvas integration, Slice L4 ("local jobs visible on the Agents
-- page") — docs/plans/agent-canvas-integration.md B.2 (data model, tables
-- 5-6 of 6), B.7 (run reports), B.11 (CLI jobs stay supported, visible
-- read-only), B.13 (monitoring).
--
-- Two tables:
--
--   1. agent_setups — one row per job the platform knows about for a given
--      agent, whether platform-published (Route 2, source = 'platform',
--      not built yet — these columns exist now so Route 2 only has to add
--      columns later, never touch RLS/shape) or CLI-only (source =
--      'local', reported read-only on every check-in, B.11). Exactly one
--      of workflow_id/local_job_id is set.
--   2. agent_setup_runs — run history for either kind of setup, the
--      outbox's server-side landing table (B.7): one row per run_id, the
--      agent's outbox idempotency key — a resend of an already-stored
--      run_id is a no-op (services/agent-bridge upserts with `on conflict
--      (run_id) do nothing`).
--
-- Both tables are written only by the bridge's withServiceRole connection
-- (same posture as platform_agents' own writes, 0069's header) — no RPC,
-- no direct client insert/update/delete grant.
--
-- Additive columns beyond the plan's literal B.2 column list (documented
-- per-column below, non-conflicting with whatever Route 2 adds later):
--   agent_setups.local_job_report — a source='local' row has no
--     connection_id/destination_connection_id (those are platform
--     connection FKs; a CLI-only job's connection lives only in the
--     agent's own local encrypted store), so there is nowhere else to put
--     the live, check-in-reported display fields (name, connection name,
--     source table, destination type/host, mode, schedule, state, error
--     class, last/next run, consecutive failures) the Agents page needs.
--     Always NULL for source='platform'.
--   agent_setups.removed_at — a local job the agent stops reporting (B.11:
--     "CLI-owned") is soft-removed, not deleted, so its run history
--     survives; NULL = still present. Only ever set for source='local'.
--   agent_setup_runs.rows_deleted/parts/mode — the run-report fields the
--     task's outbox spec lists that B.2's named column list omits.
--   agent_setup_runs.error_class (not a generic "error") — only ever a
--     classification string (e.g. "config", "transient"), never a message
--     or a Planometry rejection string (B.7: "never sent: ... Planometry
--     rejection messages").

-- =========================================================================
-- 1. agent_setups
-- =========================================================================

create table public.agent_setups (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references public.workflows (id) on delete cascade,
  local_job_id text,
  source text not null check (source in ('platform', 'local')),
  agent_id uuid not null references public.platform_agents (id) on delete cascade,
  connection_id uuid references public.connections (id),
  destination_connection_id uuid references public.connections (id),
  wanted_version integer not null default 0,
  applied_version integer not null default 0,
  rejection_reason text,
  local_job_report jsonb,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint agent_setups_workflow_xor_local check (
    (workflow_id is not null and local_job_id is null)
    or (workflow_id is null and local_job_id is not null)
  ),
  constraint agent_setups_agent_local_job_unique unique (agent_id, local_job_id)
);

create index agent_setups_agent_id_idx on public.agent_setups (agent_id);
create index agent_setups_workflow_id_idx on public.agent_setups (workflow_id);

comment on column public.agent_setups.local_job_report is
  'Live, check-in-reported display fields for a source=''local'' row '
  '(apps/agent/src/link/localJobReports.ts''s LocalJobReport shape) — '
  'name, connectionName, sourceTable, destinationType, destinationHost, '
  'mode, schedule, state, errorClass, lastRunAt, nextRunAt, '
  'consecutiveFailures. Always NULL for source=''platform''.';

comment on column public.agent_setups.removed_at is
  'Set when the agent stops reporting this local_job_id on check-in '
  '(job removed from its config) — soft-removed so agent_setup_runs '
  'history survives. Cleared back to NULL if the same local_job_id is '
  'reported again. Only ever set for source=''local'' rows.';

alter table public.agent_setups enable row level security;

-- source='platform' rows track the owning workflow's own ACL
-- (private.can_access_workflow — same helper workflow_graphs/workflow_runs
-- already use, B.2) with no agent-visibility fallback: a workflow can be
-- shared more narrowly than its agent. source='local' rows have no
-- workflow, so they fall back to plain membership on the agent's org/
-- personal workspace (B.2: "no new RLS pattern is introduced"), mirroring
-- platform_agents_select_members (0069).
create policy "agent_setups_select_members"
  on public.agent_setups for select
  using (
    (source = 'platform' and workflow_id is not null and private.can_access_workflow(workflow_id))
    or (
      source = 'local'
      and exists (
        select 1 from public.platform_agents a
        where a.id = agent_setups.agent_id
          and (
            (a.org_id is not null and private.is_member(a.org_id))
            or (a.org_id is null and a.owner_id = auth.uid())
          )
      )
    )
  );

grant select on public.agent_setups to authenticated;

-- =========================================================================
-- 2. agent_setup_runs
-- =========================================================================

create table public.agent_setup_runs (
  id uuid primary key default gen_random_uuid(),
  agent_setup_id uuid not null references public.agent_setups (id) on delete cascade,
  run_id uuid not null unique,
  status text not null check (status in ('ok', 'failed')),
  rows_sent bigint not null default 0,
  rows_deleted bigint not null default 0,
  parts integer not null default 0,
  mode text,
  duration_ms integer not null default 0,
  error_class text,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  is_realtime_aggregate boolean not null default false,
  period_start timestamptz,
  period_end timestamptz
);

create index agent_setup_runs_agent_setup_id_idx on public.agent_setup_runs (agent_setup_id, started_at desc);

comment on column public.agent_setup_runs.run_id is
  'The agent-side outbox''s idempotency key (B.7) — unique so a resend '
  '(the agent keeps a report until acked) upserts into the same row '
  'instead of duplicating it.';

comment on column public.agent_setup_runs.error_class is
  'A classification string only (e.g. "config", "transient") — never a '
  'message, never a Planometry rejection string (B.7).';

alter table public.agent_setup_runs enable row level security;

create policy "agent_setup_runs_select_members"
  on public.agent_setup_runs for select
  using (
    exists (
      select 1 from public.agent_setups s
      where s.id = agent_setup_runs.agent_setup_id
        and (
          (s.source = 'platform' and s.workflow_id is not null and private.can_access_workflow(s.workflow_id))
          or (
            s.source = 'local'
            and exists (
              select 1 from public.platform_agents a
              where a.id = s.agent_id
                and (
                  (a.org_id is not null and private.is_member(a.org_id))
                  or (a.org_id is null and a.owner_id = auth.uid())
                )
            )
          )
        )
    )
  );

grant select on public.agent_setup_runs to authenticated;
