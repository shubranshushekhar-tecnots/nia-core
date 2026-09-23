import type { SupabaseClient } from "@supabase/supabase-js";
import type { PreviewValue } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { runPreviewJob } from "../lib/previewQueue.js";

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

/**
 * Runs the destination-node read preview via the worker (lib/previewQueue.ts
 * enqueues a preview_run job and blocks on its result). Read-side only, no
 * persistence step at all — unlike runAndRecordChecks (services/checks.ts)
 * there is nothing here to record; a preview is a point-in-time read against
 * the source, shown straight to the caller and never written anywhere.
 */
export async function previewWorkflowDestination(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeId: string,
  triggeredByUserId: string,
): Promise<PreviewValue> {
  await assertWorkflowInScope(supabase, scope, workflowId);
  return runPreviewJob({ scope, workflowId, destNodeId, triggeredByUserId });
}
