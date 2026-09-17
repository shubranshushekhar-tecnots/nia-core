-- 0014_workflow_check_runs.sql
-- Phase 5 Session 3, Task 1 — persistence for the checks engine
-- (packages/schemas/src/checks.ts). Append-only, like workflow_runs
-- (0002_projects_workflows.sql): every "Run checks" click inserts a new
-- row rather than upserting one row per workflow, so a history of past
-- runs is naturally kept for free; the API/UI always reads the latest row
-- (`order by ran_at desc limit 1`) to decide gating.
--
-- Staleness is intentionally NOT a stored boolean/state machine. graph_version
-- captures workflow_graphs.version (0012_workflow_graphs.sql) at the moment
-- this run executed; the caller derives "stale" purely by comparing this run's
-- graph_version against the workflow's current workflow_graphs.version — no
-- trigger, no extra column, nothing to keep in sync when the graph changes.
-- Reuses private.can_access_workflow (0012_workflow_graphs.sql) for RLS,
-- same as workflow_graphs itself, rather than re-deriving org/personal
-- access locally.
--
-- Revision (pre-push review): the original draft here granted authenticated
-- clients a direct INSERT policy gated only by can_access_workflow, same
-- shape as workflow_graphs. That's wrong for this table specifically:
-- workflow_graphs' RLS-gated writes are fine because nothing downstream
-- trusts graph content as an attestation of anything, but a
-- workflow_check_runs row IS an attestation ("checks ran and passed") that
-- gates the Run button (Task 2). A client-writable row is therefore a
-- forgeable gate: any authorized member could PostgREST-insert a fake
-- all-pass row at the current graph_version and enable Run without checks
-- ever having executed. Fixed with the audit-log pattern already used
-- elsewhere in this schema (audit_log itself; execution-audit rows via
-- log_execution_audit, 0009_connector_write_paths.sql): SELECT stays
-- RLS-gated for clients, but the only write path is a SECURITY DEFINER
-- function that re-derives everything server-side — see record_check_run
-- below.

create table public.workflow_check_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  -- workflow_graphs.version this run was executed against. Not a foreign key
  -- (workflow_graphs has no per-version history row to reference — it's a
  -- single mutable row per workflow) — just the version number itself.
  graph_version integer not null,
  -- packages/schemas CheckResult[] (id/status/message/nodeId), server-side
  -- Zod-parsed on every write, same convention as workflow_graphs.graph:
  -- this column only guarantees valid jsonb, never the CheckResult shape.
  results jsonb not null,
  ran_at timestamptz not null default now()
);

-- Latest-run reads (`order by ran_at desc limit 1`, Task 2's gating query)
-- are the only read pattern this table has — one index covers it exactly.
create index workflow_check_runs_workflow_id_ran_at_idx
  on public.workflow_check_runs (workflow_id, ran_at desc);

alter table public.workflow_check_runs enable row level security;

create policy "workflow_check_runs_select_access"
  on public.workflow_check_runs for select
  using (private.can_access_workflow(workflow_id));

-- No insert/update/delete policy at all — see the revision note above. The
-- only write path is record_check_run() below; a run's history dies with
-- its workflow via the FK cascade above, never via a direct client delete.

grant select on public.workflow_check_runs to authenticated;

-- =========================================================================
-- record_check_run — the sole write path for workflow_check_runs
-- =========================================================================
-- Lives in `public`, not `private`: `private` is never PostgREST-exposed
-- (see 0008_connector_secret_rpc.sql's header comment for why), so a
-- `private`-schema function couldn't be called via supabase.rpc() at all —
-- `public` plus a locked-down grant is the only way to get a callable,
-- server-derived write path, same reasoning 0009_connector_write_paths.sql
-- already documents for create_connector_secret/log_execution_audit.
--
-- Called by apps/api's POST /workflows/:id/checks through req.supabase (the
-- caller's own JWT, not a service-role key — apps/api holds no service_role
-- credential, same constraint 0009's header comment documents). Because of
-- that:
--   - Authorization is re-checked here, not trusted from the route: this
--     function calls can_access_workflow(p_workflow) itself and raises if
--     the caller (auth.uid()) isn't authorized, exactly like any other
--     write path in this schema. A caller who isn't authorized for the
--     workflow gets a raised exception, not a silently-empty result.
--   - graph_version is read FROM workflow_graphs inside this same
--     statement — it is deliberately NOT a parameter. If it were a
--     parameter, an authorized-but-dishonest caller could pass a stale
--     version to make an old, no-longer-accurate run look current; reading
--     it server-side makes that forgery structurally impossible, not just
--     policy-discouraged. A workflow with no workflow_graphs row yet reads
--     back as version 0, matching workflow_graphs' own "never saved"
--     sentinel (getWorkflowGraph, apps/api/src/services/workflowGraphs.ts).
create or replace function public.record_check_run(p_workflow uuid, p_results jsonb)
returns public.workflow_check_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_row public.workflow_check_runs;
begin
  if not private.can_access_workflow(p_workflow) then
    raise exception 'not authorized for workflow %', p_workflow;
  end if;

  select version into v_version from public.workflow_graphs where workflow_id = p_workflow;
  if v_version is null then
    v_version := 0;
  end if;

  insert into public.workflow_check_runs (workflow_id, graph_version, results)
  values (p_workflow, v_version, p_results)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.record_check_run(uuid, jsonb) from public, anon;
grant execute on function public.record_check_run(uuid, jsonb) to authenticated;
