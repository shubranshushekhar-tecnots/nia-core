import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";
import type { ActingUser } from "./types.js";

/**
 * Subscription Phase 2, Slice 6: copilot tools that read or mutate a
 * specific workflow/run refuse a caller who isn't a member of that
 * workflow's project — admins/owners bypass, same rule
 * 0054/0055_workflow_project_membership.sql's RLS policies already apply
 * to the underlying tables (workflows_select_members etc: `is_admin(org_id)
 * or is_project_member(project_id)`). `opts.write` additionally refuses a
 * viewer outright regardless of project membership, for the tools that
 * actually change something (change_graph/set_destination/start_run/
 * cancel_run/revert_plan).
 *
 * This is executeTool.ts's fast-fail layer, called before the tool's
 * handler runs — RLS is still the real boundary underneath it, same
 * "defense in depth, not the only line" pattern as requireCapability.
 */
export async function requireWorkflowAccess(
  withUser: WithUser,
  user: ActingUser,
  workflowId: string,
  opts: { write: boolean },
): Promise<void> {
  const role = user.actor.role;

  // Personal workspaces have no project_members table concept — RLS's
  // owner_id = auth.uid() is the only gate there, already enforced.
  if (role === "individual") return;

  if (role !== "admin" && role !== "owner") {
    const { rows } = await withUser((db) =>
      db.query<{ is_member: boolean }>("select private.is_workflow_project_member($1) as is_member", [workflowId]),
    );
    if (!rows[0]?.is_member) {
      throw new AppError(403, "NOT_PROJECT_MEMBER", "You are not a member of this workflow's project.");
    }
  }

  if (opts.write && role === "viewer") {
    throw new AppError(403, "INSUFFICIENT_ROLE", "Viewers can't make changes. Ask an admin or owner.");
  }
}

/**
 * cancel_run's input carries a runId, not a workflowId — resolve it via
 * the same RLS-scoped read the tool's own cancel_workflow_run RPC would
 * already refuse on if the run isn't visible to this caller. Returns null
 * if the run doesn't exist/isn't visible, in which case
 * requireWorkflowAccess is skipped and the tool's own handler surfaces
 * the real error.
 */
export async function resolveWorkflowIdForRun(withUser: WithUser, runId: string): Promise<string | null> {
  const { rows } = await withUser((db) =>
    db.query<{ workflow_id: string }>("select workflow_id from public.workflow_runs where id = $1", [runId]),
  );
  return rows[0]?.workflow_id ?? null;
}
