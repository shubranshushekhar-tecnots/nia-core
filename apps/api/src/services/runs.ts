import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { EtlRunJob } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { enqueueEtlRun, getEtlRunJobData } from "../lib/runQueue.js";
import { assertWorkflowInScope } from "./checks.js";

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
