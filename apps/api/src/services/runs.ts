import { randomUUID } from "node:crypto";
import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import { EtlRunJob, GraphDoc } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
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
async function assertGraphConnectionsExist(withUser: WithUser, scope: WorkspaceScope, workflowId: string): Promise<void> {
  const { rows: graphRows } = await withUser((db) =>
    db.query<{ graph: unknown }>("select graph from workflow_graphs where workflow_id = $1", [workflowId]),
  );
  const graph = graphRows[0]?.graph;
  if (!graph) return;

  const parsed = GraphDoc.safeParse(graph);
  if (!parsed.success) return;

  const referencedNodes = parsed.data.nodes.filter((n) => n.connectionId);
  if (referencedNodes.length === 0) return;

  const connectionIds = [...new Set(referencedNodes.map((n) => n.connectionId as string))];
  const where = workspaceWhere(scope, 2);
  const { rows: existingConnections } = await withUser((db) =>
    db.query<{ id: string }>(`select id from connections where id = any($1::uuid[]) and ${where.sql}`, [
      connectionIds,
      ...where.params,
    ]),
  );
  const existingIds = new Set(existingConnections.map((c) => c.id));

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
 * Subscription Phase 3, Slice 2 (docs/plans/subscription-model.md, decisions
 * 4-6): fast, friendly pre-check — same shape as apps/web's own
 * checkWorkflowLimit/checkProjectLimit (lib/dashboard/actions.ts), except
 * the source of truth this phase enforces against isn't a DB trigger, it's
 * apps/worker's own first-chunk gate (runEtl.ts's rowsLimitBlockMessage).
 * This pre-check exists purely so a request that's already over the limit
 * fails fast with a clear message instead of silently enqueueing a job the
 * worker will immediately fail; a request that races past this check and
 * loses is still caught by the worker.
 *
 * Originally Free-only; Console overrides (0078/private.effective_plan) can
 * now also cap rows on any plan tier — staff explicitly capped it, so the
 * override wins regardless of tier (rows_override_active). Both this
 * function and runEtl.ts's rowsLimitBlockMessage resolve through the same
 * private.effective_plan so the two can never disagree.
 *
 * Reads via the caller's own withUser: private.effective_plan is
 * SECURITY DEFINER but EXECUTE-granted to `authenticated` (0078), and
 * usage_events carries member/owner-scoped SELECT RLS policies (this
 * phase's own 0066_usage_events.sql), so an acting-user query already
 * returns only what this actor may see — no service-role escalation needed
 * for a plain read.
 */
export async function assertRowsLimitNotExceeded(withUser: WithUser, scope: WorkspaceScope): Promise<void> {
  const isPersonal = !("orgId" in scope);
  const scopeValue = isPersonal ? scope.ownerId : scope.orgId;

  const { rows: planRows } = await withUser((db) =>
    db.query<{ plan_id: string; plan_name: string; rows_per_month: number | null; rows_override_active: boolean }>(
      `select plan_id, plan_name, rows_per_month, rows_override_active from private.effective_plan($1, $2)`,
      isPersonal ? [null, scope.ownerId] : [scope.orgId, null],
    ),
  );
  const plan = planRows[0];
  if (!plan || plan.rows_per_month === null) return;
  if (plan.plan_id !== "free" && !plan.rows_override_active) return;

  const { rows: usageRows } = await withUser((db) =>
    db.query<{ used: string | null }>(
      `select sum(quantity)::bigint as used
       from public.usage_events
       where kind = 'rows_moved'
         and ${isPersonal ? "owner_id" : "org_id"} = $1
         and occurred_at >= date_trunc('month', now())`,
      [scopeValue],
    ),
  );
  const used = Number(usageRows[0]?.used ?? 0);
  if (used < plan.rows_per_month) return;

  throw new AppError(
    403,
    "ROWS_LIMIT_EXCEEDED",
    `Your ${plan.plan_name} plan includes ${plan.rows_per_month.toLocaleString()} rows a month, and this workspace has already used ${used.toLocaleString()}. Upgrade to Pro to keep running workflows this month.`,
  );
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
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeIds: string[],
  triggeredByUserId: string,
): Promise<{ runs: { destNodeId: string; runId: string }[] }> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  await assertGraphConnectionsExist(withUser, scope, workflowId);
  await assertRowsLimitNotExceeded(withUser, scope);

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
  error: { message: string } | null;
  rowsProcessed: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
};

function toRunSummary(row: {
  id: string;
  workflow_id: string;
  status: string;
  error: { message: string } | null;
  rows_processed: number;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}): WorkflowRunSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRunSummary["status"],
    error: row.error,
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
 * `error` (added by supabase/migrations/0047_workflow_runs_error.sql,
 * Console v1 Slice 3c, decision 9) is the one durable copy of a run's
 * failure text — everything else (Redis pub/sub via publishRunEvent) is
 * transient and gone once the SSE stream closes. Null for any run that
 * hasn't failed, or for a pre-migration failed run that finished before
 * this column existed — get_run_result/explain_last_error should still
 * treat a null error on a failed run as "no message captured", not an
 * error condition of their own.
 */
export async function listRunsForWorkflow(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  limit = 20,
): Promise<WorkflowRunSummary[]> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  const { rows } = await withUser((db) =>
    db.query<{
      id: string;
      workflow_id: string;
      status: string;
      error: { message: string } | null;
      rows_processed: number;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
    }>(
      "select id, workflow_id, status, error, rows_processed, duration_ms, started_at, finished_at from workflow_runs where workflow_id = $1 order by started_at desc limit $2",
      [workflowId, limit],
    ),
  );
  return rows.map(toRunSummary);
}

export async function getRunStatus(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  runId: string,
): Promise<WorkflowRunSummary> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  const { rows } = await withUser((db) =>
    db.query<{
      id: string;
      workflow_id: string;
      status: string;
      error: { message: string } | null;
      rows_processed: number;
      duration_ms: number | null;
      started_at: string;
      finished_at: string | null;
    }>(
      "select id, workflow_id, status, error, rows_processed, duration_ms, started_at, finished_at from workflow_runs where id = $1 and workflow_id = $2",
      [runId, workflowId],
    ),
  );
  const data = rows[0];
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
export async function resolveRunOwnership(withUser: WithUser, actorScope: WorkspaceScope, runId: string): Promise<WorkspaceScope> {
  const job = await getEtlRunJobData(runId);
  if (job) {
    if (!sameScope(job.scope, actorScope)) {
      throw new AppError(403, "FORBIDDEN", "You don't have access to this run.");
    }
    return job.scope;
  }

  const { rows } = await withUser((db) =>
    db.query<{ org_id: string | null; owner_id: string | null }>("select org_id, owner_id from workflow_runs where id = $1", [runId]),
  );
  const data = rows[0];
  if (data?.org_id) return { orgId: data.org_id };
  if (data?.owner_id) return { ownerId: data.owner_id };
  throw new AppError(404, "NOT_FOUND", "No run found for that id.");
}
