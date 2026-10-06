import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";
import { assertWorkflowInScope } from "./checks.js";
import { assertRowsLimitNotExceeded } from "./runs.js";

/**
 * Agent-Canvas integration, Slice R5a (docs/plans/agent-canvas-integration.md
 * B.7/B.8) — actions and run history for an agent-delivered workflow.
 *
 * Action creation goes through supabase/migrations/0074_agent_setup_actions.sql's
 * create_agent_setup_action_task RPC (SECURITY DEFINER, same "RLS/DB is the
 * real trust boundary, can.ts/requireCapability is convenience only"
 * discipline as agentSetups.ts's publish_agent_setup/unpublish_agent_setup)
 * — never an HTTP hop to the bridge: services/agent-bridge's check-in
 * handler already re-queries agent_tasks fresh from the DB on every poll,
 * so an RPC-inserted row is delivered on the agent's next check-in
 * regardless of how it got there.
 */

export type AgentSetupActionKind = "test" | "run_now" | "full_reload" | "pause" | "resume" | "allow_mass_delete";

export type AgentSetupActionRequest = {
  kind: AgentSetupActionKind;
  /** run_now only — one-off parameter values for this run. */
  params?: Record<string, string>;
  /**
   * allow_mass_delete only — the explicit confirmation flag the UI must
   * show before sending ("how many rows would be removed if reported").
   * Checked here, before the RPC's own defense-in-depth state check
   * (setup must actually be paused by the mass-delete guard).
   */
  confirm?: boolean;
};

type RpcKind = "run_now" | "pause" | "resume" | "test_job";

function toRpcArgs(request: AgentSetupActionRequest): { kind: RpcKind; payload: Record<string, unknown> } {
  switch (request.kind) {
    case "test":
      return { kind: "test_job", payload: {} };
    case "pause":
      return { kind: "pause", payload: {} };
    case "resume":
      return { kind: "resume", payload: {} };
    case "full_reload":
      return { kind: "run_now", payload: { fullReload: true } };
    case "run_now": {
      const payload: Record<string, unknown> = {};
      if (request.params) payload.params = request.params;
      return { kind: "run_now", payload };
    }
    case "allow_mass_delete":
      if (request.confirm !== true) {
        throw new AppError(400, "CONFIRMATION_REQUIRED", "Allowing one large delete requires explicit confirmation.");
      }
      return { kind: "run_now", payload: { allowMassDelete: true } };
    default: {
      const _never: never = request.kind;
      throw new AppError(400, "INVALID_ACTION", `Unknown action kind ${String(_never)}.`);
    }
  }
}

export type AgentActionTask = {
  id: string;
  kind: RpcKind;
  agentSetupId: string;
};

/**
 * Allowed for any member with access to the workflow, never a viewer —
 * enforced twice: the route's requireCapability("workflows.run") (already
 * excludes viewer, packages/schemas/src/can.ts) and the RPC's own
 * private.can_write_workflow check.
 */
export async function requestAgentSetupAction(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  request: AgentSetupActionRequest,
): Promise<AgentActionTask> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  const { kind, payload } = toRpcArgs(request);

  // Safeguards slice: an org already over its monthly row limit may not
  // Run now (this covers the run_now/full_reload/allow_mass_delete family
  // — toRpcArgs maps all three onto kind "run_now") — same message and
  // check as starting a run from the canvas (runs.ts's
  // assertRowsLimitNotExceeded). test/pause/resume are never blocked: a
  // paused job staying paused, or a job already running on the agent,
  // keeps running regardless of this check.
  if (kind === "run_now") await assertRowsLimitNotExceeded(withUser, scope);

  try {
    const { rows } = await withUser((db) =>
      db.query<{ id: string; kind: RpcKind; agent_setup_id: string }>(
        "select id, kind, agent_setup_id from public.create_agent_setup_action_task($1, $2, $3)",
        [workflowId, kind, JSON.stringify(payload)],
      ),
    );
    const row = rows[0];
    if (!row) throw new AppError(409, "ACTION_FAILED", "Could not create this action.");
    return { id: row.id, kind: row.kind, agentSetupId: row.agent_setup_id };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(403, "ACTION_REFUSED", err instanceof Error ? err.message : String(err));
  }
}

export type AgentSetupRun = {
  id: string;
  runId: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  mode: string | null;
  durationMs: number;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
};

type RunRow = {
  id: string;
  run_id: string;
  status: "ok" | "failed";
  rows_sent: string | number;
  rows_deleted: string | number;
  mode: string | null;
  duration_ms: number;
  error_class: string | null;
  started_at: string;
  finished_at: string;
};

function toRun(row: RunRow): AgentSetupRun {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    rowsSent: Number(row.rows_sent),
    rowsDeleted: Number(row.rows_deleted),
    mode: row.mode,
    durationMs: row.duration_ms,
    errorClass: row.error_class,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Last 50 runs for a workflow's published setup. Readable by anyone who
 * can see the workflow — no requireCapability gate on the route, same
 * posture as agentSetups.ts's getAgentSetupState; RLS
 * (0071's agent_setup_runs_select_members policy) already allows this for
 * any workflow-viewer via private.can_access_workflow, so this plain
 * SELECT needs no RPC.
 */
export async function listAgentSetupRuns(withUser: WithUser, scope: WorkspaceScope, workflowId: string): Promise<AgentSetupRun[]> {
  await assertWorkflowInScope(withUser, scope, workflowId);

  const { rows } = await withUser((db) =>
    db.query<RunRow>(
      `select r.id, r.run_id, r.status, r.rows_sent, r.rows_deleted, r.mode, r.duration_ms, r.error_class, r.started_at, r.finished_at
       from public.agent_setup_runs r
       join public.agent_setups s on s.id = r.agent_setup_id
       where s.workflow_id = $1 and s.source = 'platform'
       order by r.started_at desc
       limit 50`,
      [workflowId],
    ),
  );

  return rows.map(toRun);
}
