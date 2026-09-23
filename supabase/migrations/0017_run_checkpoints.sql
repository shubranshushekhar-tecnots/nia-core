-- 0017_run_checkpoints.sql
-- Phase 6 Block 3.5: moves ETL run checkpoint truth into Postgres, and adds
-- a reachable 'cancelled' terminal status.
--
-- "Redis is transport, Postgres is checkpoint truth." Block 3 only ever
-- carried the resumability cursor as an offset embedded in the next BullMQ
-- job's payload (never persisted). apps/worker/src/lib/etl/runEtl.ts now
-- writes the keyset cursor into this same row in the SAME step as
-- rows_processed (workflowRuns.ts's recordChunkProgress) — the BullMQ job
-- payload's own cursor field becomes a hint only; on job start, a
-- non-null persisted cursor here always wins over the payload's, since a
-- job can be redelivered (BullMQ stall/retry) with a stale payload cursor
-- from before its own last successful chunk, but this row is only ever
-- advanced after that chunk's write already succeeded.
--
-- Chose a column on workflow_runs over a new run_checkpoints table:
-- there is exactly one live cursor per run (not a history), it's written
-- by the exact same call/row as rows_processed already, and workflow_runs
-- already has no client-writable RLS policy (worker/service_role only per
-- 0002's header comment) — a separate table would need to duplicate that
-- same RLS shape for no benefit.
--
-- Enum value addition is split into its own statement (not combined with
-- any DML using the new value in this same transaction) per 0003's
-- established precedent for public.org_role's 'owner' value.

alter type public.workflow_run_status add value if not exists 'cancelled';

alter table public.workflow_runs add column cursor_json text;

comment on column public.workflow_runs.cursor_json is
  'JSON-serialized keyset cursor ({"lastKey": ...}), written by the worker '
  'in the same step as rows_processed. Null until the first chunk '
  'completes. The durable checkpoint a resumed/redelivered job consults '
  '(and prefers) over its own BullMQ payload''s cursor field.';

-- =========================================================================
-- cancel_workflow_run — cooperative cancel signal, checked between chunks
-- =========================================================================
-- Client-callable despite workflow_runs having no direct client UPDATE
-- policy (system-authored table, same posture as 0014's workflow_check_runs
-- and 0016's write_grants) — same two-step "verify workspace access, then
-- SECURITY DEFINER does the actual write" shape as 0016's RPCs. Only flips
-- a 'running' row to 'cancelled'; a no-op (0 rows) if the run has already
-- reached a terminal status, so a late/duplicate cancel call is harmless.
-- The runner itself (runEtl.ts) is what actually stops work and sets
-- finished_at/duration_ms once it observes this status at its next
-- between-chunk poll — this function only flips the flag.

create or replace function public.cancel_workflow_run(p_run_id uuid)
returns public.workflow_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_row public.workflow_runs;
begin
  select org_id into v_org_id from public.workflow_runs where id = p_run_id;
  if v_org_id is null then
    raise exception 'workflow run % not found', p_run_id;
  end if;

  if not private.is_member(v_org_id) then
    raise exception 'not authorized for workflow run %', p_run_id;
  end if;

  update public.workflow_runs
    set status = 'cancelled'
    where id = p_run_id and status = 'running'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'workflow run % is not running (already finished or cancelled)', p_run_id;
  end if;

  insert into public.audit_log (org_id, actor, action, detail)
  values (v_org_id, auth.uid(), 'workflow_run.cancelled', jsonb_build_object('runId', p_run_id));

  return v_row;
end;
$$;

revoke execute on function public.cancel_workflow_run(uuid) from public, anon;
grant execute on function public.cancel_workflow_run(uuid) to authenticated;
