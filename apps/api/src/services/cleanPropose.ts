import type { SupabaseClient } from "@supabase/supabase-js";
import type { CleanProposalResult } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { runProposeCleaningJob } from "../lib/cleanQueue.js";

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

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
 * log_cleaning_proposed RPC — per CLAUDE.md's "the audit log is load-
 * bearing" note and Step 6's "record LLM prompts and outputs in the audit
 * log" requirement, this fires at PROPOSE time regardless of whether the
 * user ever applies the result (distinct from log_plan_diff_applied,
 * 0023, which only fires on apply). Best-effort: a logging failure must
 * never fail the propose call itself, since nothing has been written yet
 * for the caller to roll back — same "log, don't throw" convention as
 * putWorkflowGraph's unbindStaleCleanPlans.
 */
export async function proposeCleaningForWorkflow(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  nodeId: string,
  triggeredByUserId: string,
): Promise<CleanProposalResult> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  const result = await runProposeCleaningJob({ scope, workflowId, nodeId, triggeredByUserId });

  const specialists = [...new Set(result.columns.map((c) => c.specialist))];
  const { error } = await supabase.rpc("log_cleaning_proposed", {
    p_workflow_id: workflowId,
    p_node_id: nodeId,
    p_summary: result.diff.summary,
    p_specialists: specialists,
  });
  if (error) {
    console.error(`proposeCleaningForWorkflow: failed to log audit event for workflow ${workflowId} node ${nodeId}:`, error.message);
  }

  return result;
}
