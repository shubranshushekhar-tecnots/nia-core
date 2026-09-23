import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { EtlRunJob, GraphDoc } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { enqueueEtlRun, getEtlRunJobData } from "../lib/runQueue.js";
import { assertWorkflowInScope } from "./checks.js";

/**
 * Refuse-to-run guard: a node's connectionId can go stale if its
 * connection was deleted from another tab/the Connections page after the
 * canvas last loaded — nothing else in the enqueue path checks this
 * (runEtl.ts resolves connections in the worker, but only once a chunk job
 * is already running). Checking every node with a connectionId, not just
 * destNodeIds, since an upstream source node's connection is just as
 * fatal to the run as the destination's. Message flows through
 * RunApiError -> the existing run-status-card error path unchanged — no
 * new client code needed for this to surface.
 */
async function assertGraphConnectionsExist(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  const { data } = await supabase.from("workflow_graphs").select("graph").eq("workflow_id", workflowId).maybeSingle();
  if (!data) return;

  const parsed = GraphDoc.safeParse(data.graph);
  if (!parsed.success) return;

  const referencedNodes = parsed.data.nodes.filter((n) => n.connectionId);
  if (referencedNodes.length === 0) return;

  const connectionIds = [...new Set(referencedNodes.map((n) => n.connectionId as string))];
  let query = supabase.from("connections").select("id").in("id", connectionIds);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: existingConnections } = await query;
  const existingIds = new Set((existingConnections ?? []).map((c) => c.id as string));

  const missingNode = referencedNodes.find((n) => !existingIds.has(n.connectionId as string));
  if (missingNode) {
    throw new AppError(
      409,
      "CONNECTION_MISSING",
      `Can't run — the connection for "${missingNode.manifestId ?? missingNode.id}" was deleted.`,
    );
  }
}

/**
 * Phase 6 Block 3 — starting and re-attaching to an ETL run.
 *
 * Block 5 (Part 3d): scope-generic, org XOR personal — `workflow_runs` has
 * carried a nullable owner_id + org_xor_owner check constraint + owner-aware
 * select policy since 0005_individual_workspace.sql, so no migration was
 * needed here; only EtlRunJob's payload and this file were still hardcoded
 * to orgId. `assertWorkflowInScope` (checks.ts) is reused as-is — the same
 * "workflow exists in this scope, else 404" guard chat/checks already share.
 */

/**
 * Enqueues the first chunk job (cursor: null) and mints the runId the
 * client will poll/stream against from here on. Does NOT create the
 * `workflow_runs` row itself — that table has no client-writable RLS
 * policy at all (its own migration comment: "runs are written exclusively
 * by the worker via the service_role key"), so the row only exists once
 * runEtl.ts's first chunk actually starts (see workflowRuns.ts's startRun).
 * A client that opens GET /:id/run/stream before that happens still works:
 * ownership for the stream is proven via the still-queued/in-flight BullMQ
 * job itself (see resolveRunOwnership below), not a row lookup.
 *
 * Block 5 (multi-destination fan-out): `destNodeIds` is a non-empty array,
 * not a single id — each destination gets its own independent runId,
 * `workflow_runs` row, checkpoint, and SSE stream (runEtl.ts, workflowRuns.ts,
 * and publish.ts are all already scoped per-runId and need no change here).
 * A failure enqueueing one destination doesn't roll back the others already
 * enqueued — each run is independent by construction, same as running them
 * one at a time from the UI would be; the caller gets back exactly which
 * destNodeId maps to which runId so it can track each stream separately.
 */
export async function startWorkflowRun(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeIds: string[],
  triggeredByUserId: string,
): Promise<{ runs: { destNodeId: string; runId: string }[] }> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  await assertGraphConnectionsExist(supabase, scope, workflowId);

  const runs: { destNodeId: string; runId: string }[] = [];
  for (const destNodeId of destNodeIds) {
    const runId = randomUUID();
    await enqueueEtlRun(
      EtlRunJob.parse({
        kind: "etl_run",
        scope,
        workflowId,
        runId,
        nodeId: destNodeId,
        cursor: null,
        triggeredByUserId,
      }),
    );
    runs.push({ destNodeId, runId });
  }
  return { runs };
}

export type WorkflowRunSummary = {
  id: string;
  workflowId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  rowsProcessed: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
};

function toRunSummary(row: {
  id: string;
  workflow_id: string;
  status: string;
  rows_processed: number;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}): WorkflowRunSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRunSummary["status"],
    rowsProcessed: row.rows_processed,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Copilot agent (docs/plans/copilot-agent.md, Part 2) — list_runs/get_run_status/
 * get_run_result tools' backing reads. Plain RLS-scoped selects against
 * `workflow_runs`, the same table and the same "row visibility through the
 * caller's own req.supabase client is itself the access proof" reasoning
 * resolveRunOwnership above already relies on — not a new privileged path.
 *
 * NOTE: `workflow_runs` has no persisted failure-message column — the
 * worker's real per-failure text (runEtl.ts's `fail()`) is only ever
 * published transiently over Redis to an open SSE stream (publishRunEvent),
 * never written to this row. A run read after its stream has closed can
 * only report `status: "failed"` plus counters, not the original message.
 * This is a pre-existing architectural gap, not something introduced or
 * fixed here — see docs/plans/copilot-agent.md's Close section deviation
 * note for get_run_result/explain_last_error.
 */
export async function listRunsForWorkflow(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  limit = 20,
): Promise<WorkflowRunSummary[]> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  const { data } = await supabase
    .from("workflow_runs")
    .select("id, workflow_id, status, rows_processed, duration_ms, started_at, finished_at")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map(toRunSummary);
}

export async function getRunStatus(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  runId: string,
): Promise<WorkflowRunSummary> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  const { data } = await supabase
    .from("workflow_runs")
    .select("id, workflow_id, status, rows_processed, duration_ms, started_at, finished_at")
    .eq("id", runId)
    .eq("workflow_id", workflowId)
    .maybeSingle();
  if (!data) throw new AppError(404, "NOT_FOUND", "No run found for that id on this workflow.");
  return toRunSummary(data);
}

/** Structural equality for the org/owner XOR union — same helper as routes/chat.ts's sameScope. */
function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return ("orgId" in a && "orgId" in b && a.orgId === b.orgId) || ("ownerId" in a && "ownerId" in b && a.ownerId === b.ownerId);
}

/**
 * Resolves which WorkspaceScope owns a run, for GET /:id/run/stream's
 * ownership check before ever subscribing to its Redis channel.
 *
 * Two paths, in order:
 *  1. The enqueued BullMQ job for this runId still exists (covers the
 *     common case: client opens the stream right after POST /:id/run's
 *     202) — its own `scope` is the trust anchor, same "scope was set
 *     server-side at enqueue time" reasoning chat.ts's getChatJobData path
 *     documents. Compared against the requesting actor's own scope.
 *  2. The job is gone — either the run has advanced past its first chunk
 *     (each chunk replaces the previous job under a fresh jobId, per
 *     runQueue.ts) or it already finished. Falls back to the durable
 *     `workflow_runs` row, read through the caller's OWN req.supabase — a
 *     real, RLS-protected table (unlike chat's ephemeral conversationId),
 *     so a row actually being visible is itself the proof of access; no
 *     separate sameScope comparison needed on this path. org_id and owner_id
 *     are mutually exclusive on that row (org_xor_owner check constraint),
 *     so exactly one of them is set.
 */
export async function resolveRunOwnership(
  supabase: SupabaseClient,
  actorScope: WorkspaceScope,
  runId: string,
): Promise<WorkspaceScope> {
  const job = await getEtlRunJobData(runId);
  if (job) {
    if (!sameScope(job.scope, actorScope)) {
      throw new AppError(403, "FORBIDDEN", "You don't have access to this run.");
    }
    return job.scope;
  }

  const { data } = await supabase.from("workflow_runs").select("org_id, owner_id").eq("id", runId).maybeSingle();
  if (data?.org_id) return { orgId: data.org_id as string };
  if (data?.owner_id) return { ownerId: data.owner_id as string };
  throw new AppError(404, "NOT_FOUND", "No run found for that id.");
}
