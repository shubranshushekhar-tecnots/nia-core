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
 */
export async function recordChunkProgress(runId: string, rowsWrittenThisChunk: number): Promise<number> {
  const { data } = await supabase.from("workflow_runs").select("rows_processed").eq("id", runId).maybeSingle();
  const total = (data?.rows_processed ?? 0) + rowsWrittenThisChunk;
  await supabase.from("workflow_runs").update({ rows_processed: total }).eq("id", runId);
  return total;
}

export async function finishRun(runId: string, status: "succeeded" | "failed"): Promise<number> {
  const { data } = await supabase.from("workflow_runs").select("started_at").eq("id", runId).maybeSingle();
  const finishedAt = new Date();
  const durationMs = data?.started_at ? finishedAt.getTime() - new Date(data.started_at as string).getTime() : 0;
  await supabase
    .from("workflow_runs")
    .update({ status, finished_at: finishedAt.toISOString(), duration_ms: durationMs })
    .eq("id", runId);
  return durationMs;
}
