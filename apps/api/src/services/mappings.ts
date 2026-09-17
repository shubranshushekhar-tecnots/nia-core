import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProposalSchema } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { runProposeMappingJob } from "../lib/mappingsQueue.js";

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
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
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeId: string,
  triggeredByUserId: string,
): Promise<ProposalSchema> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  return runProposeMappingJob({ scope, workflowId, destNodeId, triggeredByUserId });
}
