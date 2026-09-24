import { workspaceWhere, type WorkspaceScope } from "@nia/db";
import type { ProposalSchema } from "@nia/schemas";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { runProposeMappingJob } from "../lib/mappingsQueue.js";

async function assertWorkflowInScope(withUser: WithUser, scope: WorkspaceScope, workflowId: string): Promise<void> {
  const where = workspaceWhere(scope, 2);
  const { rowCount } = await withUser((db) =>
    db.query(`select 1 from workflows where id = $1 and ${where.sql} limit 1`, [workflowId, ...where.params]),
  );
  if (!rowCount) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

/**
 * Runs the propose flow via the worker (lib/mappingsQueue.ts enqueues a
 * mappings_propose job and blocks on its result). Unlike
 * runAndRecordChecks (services/checks.ts), this deliberately has NO
 * persistence step — a proposal is returned straight to the caller and
 * NEVER auto-applied to the destination node's config. Approval (setting
 * entries + version++ + approvedAt) happens later, as an ordinary
 * PUT /:id/graph call the drawer UI issues explicitly once the user clicks
 * Approve — the same graph-save path every other node-config edit already
 * goes through, not a new persistence mechanism.
 */
export async function proposeMappingForWorkflow(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeId: string,
  triggeredByUserId: string,
): Promise<ProposalSchema> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  return runProposeMappingJob({ scope, workflowId, destNodeId, triggeredByUserId });
}
