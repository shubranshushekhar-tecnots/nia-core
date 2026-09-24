import { withServiceRole, type WorkspaceScope } from "@nia/db";
import { dbPool } from "../dbPool.js";

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
 *
 * Block 5 (Part 3d): scope-generic — writes org_id or owner_id depending on
 * which half of the WorkspaceScope union the job carries. `workflow_runs`
 * has enforced an org_xor_owner check constraint (and an owner-aware select
 * policy) since 0005_individual_workspace.sql, so exactly one of the two
 * columns is ever set on a row; no migration was needed for this change.
 */
export async function startRun(runId: string, workflowId: string, scope: WorkspaceScope): Promise<void> {
  await withServiceRole(dbPool, (db) =>
    db.query(
      `insert into public.workflow_runs (id, workflow_id, org_id, owner_id, status, rows_processed, started_at)
       values ($1, $2, $3, $4, 'running', 0, now())
       on conflict (id) do nothing`,
      [runId, workflowId, "orgId" in scope ? scope.orgId : null, "ownerId" in scope ? scope.ownerId : null],
    ),
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
  const selectResult = await withServiceRole(dbPool, (db) =>
    db.query<{ rows_processed: number }>("select rows_processed from public.workflow_runs where id = $1", [runId]),
  );
  const total = (selectResult.rows[0]?.rows_processed ?? 0) + rowsWrittenThisChunk;
  await withServiceRole(dbPool, (db) =>
    db.query("update public.workflow_runs set rows_processed = $1, cursor_json = $2 where id = $3", [total, cursorJson, runId]),
  );
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
  const result = await withServiceRole(dbPool, (db) =>
    db.query<{ status: string; cursor_json: string | null }>("select status, cursor_json from public.workflow_runs where id = $1", [runId]),
  );
  const data = result.rows[0];
  return { status: data!.status as RunCheckpoint["status"], cursor: data!.cursor_json ?? null };
}

export async function finishRun(runId: string, status: "succeeded" | "failed" | "cancelled"): Promise<number> {
  const selectResult = await withServiceRole(dbPool, (db) =>
    db.query<{ started_at: string | null }>("select started_at from public.workflow_runs where id = $1", [runId]),
  );
  const startedAt = selectResult.rows[0]?.started_at ?? null;
  const finishedAt = new Date();
  const durationMs = startedAt ? finishedAt.getTime() - new Date(startedAt).getTime() : 0;
  await withServiceRole(dbPool, (db) =>
    db.query("update public.workflow_runs set status = $1, finished_at = $2, duration_ms = $3 where id = $4", [
      status,
      finishedAt.toISOString(),
      durationMs,
      runId,
    ]),
  );
  return durationMs;
}
