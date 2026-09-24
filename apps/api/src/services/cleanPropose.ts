import type { CleanProposalResult } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";
import { runProposeCleaningJob } from "../lib/cleanQueue.js";
import { assertWorkflowInScope } from "./checks.js";

/**
 * Phase 13, Step 7 — "Propose cleaning". Runs the flow via the worker
 * (lib/cleanQueue.ts enqueues a clean_propose job and blocks on its
 * result), same no-persistence shape as proposeMappingForWorkflow
 * (services/mappings.ts): the returned proposal is only ever applied via
 * the existing, separate, explicit /plan/apply-diff call (its optional
 * `cleanBinding` field is what actually writes a clean_plans row —
 * nothing here does).
 *
 * Records the proposal itself in the audit log via 0024_clean_plans.sql's
 * log_cleaning_proposed RPC — per CONVENTIONS.md's "the audit log is load-
 * bearing" note and Step 6's "record LLM prompts and outputs in the audit
 * log" requirement, this fires at PROPOSE time regardless of whether the
 * user ever applies the result (distinct from log_plan_diff_applied,
 * 0023, which only fires on apply). Best-effort: a logging failure must
 * never fail the propose call itself, since nothing has been written yet
 * for the caller to roll back — same "log, don't throw" convention as
 * putWorkflowGraph's unbindStaleCleanPlans.
 */
export async function proposeCleaningForWorkflow(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  nodeId: string,
  triggeredByUserId: string,
): Promise<CleanProposalResult> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  const result = await runProposeCleaningJob({ scope, workflowId, nodeId, triggeredByUserId });

  const specialists = [...new Set(result.columns.map((c) => c.specialist))];
  try {
    await withUser((db) =>
      db.query("select public.log_cleaning_proposed($1, $2, $3, $4)", [
        workflowId,
        nodeId,
        result.diff.summary,
        JSON.stringify(specialists),
      ]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`proposeCleaningForWorkflow: failed to log audit event for workflow ${workflowId} node ${nodeId}:`, message);
  }

  return result;
}
