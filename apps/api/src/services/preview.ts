import type { PreviewValue } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";
import { runPreviewJob } from "../lib/previewQueue.js";
import { assertWorkflowInScope } from "./checks.js";

/**
 * Runs the destination-node read preview via the worker (lib/previewQueue.ts
 * enqueues a preview_run job and blocks on its result). Read-side only, no
 * persistence step at all — unlike runAndRecordChecks (services/checks.ts)
 * there is nothing here to record; a preview is a point-in-time read against
 * the source, shown straight to the caller and never written anywhere.
 */
export async function previewWorkflowDestination(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
  destNodeId: string,
  triggeredByUserId: string,
): Promise<PreviewValue> {
  await assertWorkflowInScope(withUser, scope, workflowId);
  return runPreviewJob({ scope, workflowId, destNodeId, triggeredByUserId });
}
