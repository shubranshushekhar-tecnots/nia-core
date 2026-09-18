import { supabase } from "../supabaseClient.js";

/**
 * Phase 6 Block 3 — the ETL runner's own writes to `workflow_runs`
 * (supabase/migrations/0002_projects_workflows.sql). That table has no
 * insert/update/delete RLS policy at all — "runs are written exclusively by
 * the worker via the service_role key" per its own migration comment — so
 * apps/api's `POST /:id/run` route cannot create this row itself; it only
 * enqueues the first EtlRunJob. This module is the only writer.
 */

/**
 * Idempotently starts a run — called by runEtl.ts on the first chunk
 * (`job.cursor === null`) only. Uses an upsert with `ignoreDuplicates` so a
 * BullMQ stalled-job retry redelivering that exact same first job (worker
 * killed mid-chunk, per Block 4's eventual resilience bar) never crashes on
 * a duplicate-key insert — it just leaves the original row as-is.
 */
export async function startRun(runId: string, workflowId: string, orgId: string): Promise<void> {
  await supabase.from("workflow_runs").upsert(
    {
      id: runId,
      workflow_id: workflowId,
      org_id: orgId,
      status: "running",
      rows_processed: 0,
      started_at: new Date().toISOString(),
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
}

/**
 * Chunks within one run are strictly sequential (each chunk's job only
 * enqueues the next after it finishes — see runEtl.ts), never concurrent,
 * so a plain read-then-write increment is safe here without a DB-level
 * atomic increment.
 *
 * Phase 6 Block 3.5: `cursorJson` is written in this SAME update as
 * `rows_processed` — this row is the "Redis is transport, Postgres is
 * checkpoint truth" checkpoint (see 0017_run_checkpoints.sql's header
 * comment). Only reached after the chunk's destination write has already
 * succeeded (runEtl.ts's `fail()` short-circuits before this call), so
 * cursor_json only ever advances past a chunk that's durably landed.
 */
export async function recordChunkProgress(runId: string, rowsWrittenThisChunk: number, cursorJson: string): Promise<number> {
  const { data } = await supabase.from("workflow_runs").select("rows_processed").eq("id", runId).maybeSingle();
  const total = (data?.rows_processed ?? 0) + rowsWrittenThisChunk;
  await supabase.from("workflow_runs").update({ rows_processed: total, cursor_json: cursorJson }).eq("id", runId);
  return total;
}

export type RunCheckpoint = { status: "running" | "succeeded" | "failed" | "cancelled"; cursor: string | null };

/**
 * One read, consulted at the start of every chunk (including the first,
 * right after startRun): `cursor` is the persisted keyset checkpoint
 * (preferred over the BullMQ job payload's own cursor field whenever
 * non-null — see runEtl.ts), and `status` is polled here too rather than
 * with a second round-trip, since cancel (Block 3.5) is only checked
 * between chunks and this call already reads the same row.
 */
export async function getRunCheckpoint(runId: string): Promise<RunCheckpoint> {
  const { data } = await supabase.from("workflow_runs").select("status, cursor_json").eq("id", runId).single();
  return { status: data!.status as RunCheckpoint["status"], cursor: (data!.cursor_json as string | null) ?? null };
}

export async function finishRun(runId: string, status: "succeeded" | "failed" | "cancelled"): Promise<number> {
  const { data } = await supabase.from("workflow_runs").select("started_at").eq("id", runId).maybeSingle();
  const finishedAt = new Date();
  const durationMs = data?.started_at ? finishedAt.getTime() - new Date(data.started_at as string).getTime() : 0;
  await supabase
    .from("workflow_runs")
    .update({ status, finished_at: finishedAt.toISOString(), duration_ms: durationMs })
    .eq("id", runId);
  return durationMs;
}
