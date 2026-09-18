import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { EtlRunJob } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { enqueueEtlRun, getEtlRunJobData } from "../lib/runQueue.js";

/**
 * Phase 6 Block 3 — starting and re-attaching to an ETL run.
 *
 * Org-only, matching EtlRunJob's own scope shape (packages/schemas/src/
 * jobs.ts's header comment: workflow execution/write grants haven't been
 * scoped for personal workspaces yet, unlike checks/chat/preview which are
 * all read-only). A personal-workspace ("individual") actor is refused here
 * with a clear 400, not a confusing schema-parse crash inside EtlRunJob.parse.
 */
function requireOrgScope(scope: WorkspaceScope): string {
  if (!("orgId" in scope)) {
    throw new AppError(400, "VALIDATION_ERROR", "Running a workflow requires an organization workspace.");
  }
  return scope.orgId;
}

async function assertWorkflowInOrg(supabase: SupabaseClient, orgId: string, workflowId: string): Promise<void> {
  const { count } = await supabase
    .from("workflows")
    .select("id", { count: "exact", head: true })
    .eq("id", workflowId)
    .eq("org_id", orgId);
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

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
 */
export async function startWorkflowRun(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeId: string,
  triggeredByUserId: string,
): Promise<{ runId: string }> {
  const orgId = requireOrgScope(scope);
  await assertWorkflowInOrg(supabase, orgId, workflowId);

  const runId = randomUUID();
  await enqueueEtlRun(
    EtlRunJob.parse({
      kind: "etl_run",
      orgId,
      workflowId,
      runId,
      nodeId: destNodeId,
      cursor: null,
      triggeredByUserId,
    }),
  );
  return { runId };
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
 *     202) — its own `orgId` is the trust anchor, same "scope was set
 *     server-side at enqueue time" reasoning chat.ts's getChatJobData path
 *     documents. Compared against the requesting actor's own scope.
 *  2. The job is gone — either the run has advanced past its first chunk
 *     (each chunk replaces the previous job under a fresh jobId, per
 *     runQueue.ts) or it already finished. Falls back to the durable
 *     `workflow_runs` row, read through the caller's OWN req.supabase — a
 *     real, RLS-protected table (unlike chat's ephemeral conversationId),
 *     so a row actually being visible is itself the proof of access; no
 *     separate sameScope comparison needed on this path.
 */
export async function resolveRunOwnership(
  supabase: SupabaseClient,
  actorScope: WorkspaceScope,
  runId: string,
): Promise<WorkspaceScope> {
  const job = await getEtlRunJobData(runId);
  if (job) {
    const jobScope: WorkspaceScope = { orgId: job.orgId };
    if (!sameScope(jobScope, actorScope)) {
      throw new AppError(403, "FORBIDDEN", "You don't have access to this run.");
    }
    return jobScope;
  }

  const { data } = await supabase.from("workflow_runs").select("org_id").eq("id", runId).maybeSingle();
  if (!data?.org_id) {
    throw new AppError(404, "NOT_FOUND", "No run found for that id.");
  }
  return { orgId: data.org_id as string };
}
