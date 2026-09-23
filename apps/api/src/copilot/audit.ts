import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../lib/appError.js";
import type { ActingUser } from "./types.js";
import type { ToolTier } from "./types.js";

/**
 * Copilot agent (Part 1): "Every tool call is written to the audit log
 * with the user and source: 'copilot'." Calls the new
 * log_copilot_tool_call rpc (0031_copilot_agent.sql) through the caller's
 * own req.supabase — never a service-role client, same reasoning as every
 * other audited write in this codebase (private.log_audit relies on
 * auth.uid()). Throws (never best-effort/swallowed) per CONVENTIONS.md's "audit
 * log is load-bearing" doctrine — a tool call whose audit write fails does
 * not get to silently succeed.
 */
export async function auditToolCall(
  supabase: SupabaseClient,
  user: ActingUser,
  params: { tool: string; tier: ToolTier; workflowId: string | null; summary: string },
): Promise<void> {
  const { error } = await supabase.rpc("log_copilot_tool_call", {
    p_org_id: "orgId" in user.scope ? user.scope.orgId : null,
    p_owner_id: "ownerId" in user.scope ? user.scope.ownerId : null,
    p_tool: params.tool,
    p_tier: params.tier,
    p_workflow_id: params.workflowId,
    p_summary: params.summary,
  });
  if (error) throw new AppError(500, "AUDIT_WRITE_FAILED", error.message);
}
