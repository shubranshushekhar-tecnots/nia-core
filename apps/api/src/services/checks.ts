import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import { CheckResult } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { runCheckRunJob } from "../lib/checksQueue.js";

export type WorkflowCheckRun = {
  id: string;
  workflowId: string;
  graphVersion: number;
  results: CheckResult[];
  ranAt: string;
};

const ALL_CHECKS = ["config", "dag", "credentials", "mappings", "grants"] as const;

/** Exported for other workflow-scoped services (chat's conversation lookup, the Logs-tab activity feed) that need the same "workflow exists in this scope, else 404" guard without duplicating it. */
export async function assertWorkflowInScope(withUser: WithUser, scope: WorkspaceScope, workflowId: string): Promise<void> {
  const where = workspaceWhere(scope, 2);
  const { rowCount } = await withUser((db) =>
    db.query(`select 1 from workflows where id = $1 and ${where.sql} limit 1`, [workflowId, ...where.params]),
  );
  if (!rowCount) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

function parseRow(row: { id: string; workflow_id: string; graph_version: number; results: unknown; ran_at: string }): WorkflowCheckRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    graphVersion: row.graph_version,
    results: CheckResult.array().parse(row.results),
    ranAt: row.ran_at,
  };
}

/**
 * Runs the full check suite via the worker (lib/checksQueue.ts enqueues a
 * check_run job and blocks on its result — see that file's header comment
 * for why this is synchronous rather than SSE/polling), then persists the
 * results through the public.record_check_run function using THIS
 * request's own acting-user role (withUser) — never the worker's
 * service_role. That split is required, not just a convention:
 * private.can_access_workflow (called inside the function) relies on
 * auth.uid(), which is only ever populated for a call carrying the
 * caller's own JWT claims (withActingUser's SET LOCAL + request.jwt.claims),
 * never for a service_role call. See
 * supabase/migrations/0014_workflow_check_runs.sql's header comment.
 */
export async function runAndRecordChecks(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  triggeredByUserId: string,
): Promise<WorkflowCheckRun> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const results = await runCheckRunJob({
    scope,
    workflowId,
    checks: [...ALL_CHECKS],
    triggeredByUserId,
  });

  let row: { id: string; workflow_id: string; graph_version: number; results: unknown; ran_at: string };
  try {
    const { rows } = await withUser((db) =>
      db.query<typeof row>("select * from public.record_check_run($1, $2)", [workflowId, JSON.stringify(results)]),
    );
    row = rows[0]!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(403, "CHECK_RUN_DENIED", message);
  }

  return parseRow(row);
}

export async function getLatestCheckRun(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<WorkflowCheckRun | null> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const { rows } = await withUser((db) =>
    db.query<{ id: string; workflow_id: string; graph_version: number; results: unknown; ran_at: string }>(
      "select id, workflow_id, graph_version, results, ran_at from workflow_check_runs where workflow_id = $1 order by ran_at desc limit 1",
      [workflowId],
    ),
  );

  return rows[0] ? parseRow(rows[0]) : null;
}

/** Full history (newest first, capped at `limit`) — the Logs tab's check-run source (Phase 5 Session 4), distinct from getLatestCheckRun's single-row read. */
export async function listCheckRuns(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  limit = 20,
): Promise<WorkflowCheckRun[]> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const { rows } = await withUser((db) =>
    db.query<{ id: string; workflow_id: string; graph_version: number; results: unknown; ran_at: string }>(
      "select id, workflow_id, graph_version, results, ran_at from workflow_check_runs where workflow_id = $1 order by ran_at desc limit $2",
      [workflowId, limit],
    ),
  );

  return rows.map(parseRow);
}
