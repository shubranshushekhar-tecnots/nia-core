import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";
import type { ActingUser } from "./types.js";
import type { ToolTier } from "./types.js";

/**
 * Copilot agent (Part 1): "Every tool call is written to the audit log
 * with the user and source: 'copilot'." Calls the
 * log_copilot_tool_call function (0031_copilot_agent.sql) through the
 * caller's own withUser — never a service-role connection, same reasoning
 * as every other audited write in this codebase (private.log_audit relies
 * on auth.uid()). Throws (never best-effort/swallowed) per CONVENTIONS.md's "audit
 * log is load-bearing" doctrine — a tool call whose audit write fails does
 * not get to silently succeed.
 */
export async function auditToolCall(
  withUser: WithUser,
  user: ActingUser,
  params: { tool: string; tier: ToolTier; workflowId: string | null; summary: string },
): Promise<void> {
  try {
    await withUser((db) =>
      db.query("select public.log_copilot_tool_call($1, $2, $3, $4, $5, $6)", [
        "orgId" in user.scope ? user.scope.orgId : null,
        "ownerId" in user.scope ? user.scope.ownerId : null,
        params.tool,
        params.tier,
        params.workflowId,
        params.summary,
      ]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "AUDIT_WRITE_FAILED", message);
  }
}
