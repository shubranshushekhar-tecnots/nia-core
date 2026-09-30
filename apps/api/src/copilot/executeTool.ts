import { getTool } from "./registry.js";
import { auditToolCall } from "./audit.js";
import { requireWorkflowAccess, resolveWorkflowIdForRun } from "./requireWorkflowAccess.js";
import { AppError } from "../lib/appError.js";
import type { ActingUser, ToolRender } from "./types.js";
import type { WithUser } from "../lib/withUser.js";

export type ToolCallResult = { summary: string; render: ToolRender };

// Subscription Phase 2, Slice 6: every tool that reads or changes a
// specific workflow/run goes through requireWorkflowAccess before its
// handler runs. WRITE_TOOLS additionally refuses a viewer outright — see
// requireWorkflowAccess.ts's header comment for the full rule. Tools
// scoped to a connection instead of a workflow (list_connections,
// describe_source, get_profile, explain_write_grant,
// explain_source_rls_policy, explain_missing_privilege) aren't in this
// set — they have no "workflow's project" to check membership against.
const WORKFLOW_SCOPED_TOOLS = new Set([
  "get_workflow",
  "preview_rows",
  "list_runs",
  "get_run_status",
  "get_run_result",
  "explain_last_error",
  "change_graph",
  "propose_cleaning",
  "set_destination",
  "propose_mapping",
  "revert_plan",
  "start_run",
  "cancel_run",
]);
const WRITE_TOOLS = new Set(["change_graph", "set_destination", "start_run", "cancel_run", "revert_plan"]);

/**
 * Copilot agent (Part 1/3) — the one place every tool call actually runs
 * through, whether invoked by the agent loop or by the confirm-and-execute
 * path. Validates input against the tool's own schema (never trusts the
 * model's raw JSON), calls the handler with the caller's own identity via
 * withUser (never service-role), then unconditionally audits the call
 * (Part 1: "Every tool call is written to the audit log").
 *
 * `pendingActionId` is only ever supplied by the dedicated confirm-and-
 * execute path (routes/copilotAgent.ts), never by the agent loop itself —
 * that asymmetry is what makes Part 3's "only a click in the user's
 * session confirms it" true: the model can request start_run all it wants,
 * but every such call from the loop omits pendingActionId, so the tool's
 * own handler always takes the "create a pending action, don't run
 * anything yet" branch.
 */
export async function executeTool(
  withUser: WithUser,
  user: ActingUser,
  name: string,
  rawArgs: unknown,
  opts: { pendingActionId?: string } = {},
): Promise<ToolCallResult> {
  const tool = getTool(name);
  if (!tool) throw new AppError(400, "UNKNOWN_TOOL", `No such tool "${name}".`);

  const input = tool.inputSchema.parse(rawArgs);

  if (WORKFLOW_SCOPED_TOOLS.has(name)) {
    const workflowId =
      typeof (input as { workflowId?: unknown }).workflowId === "string"
        ? (input as { workflowId: string }).workflowId
        : await resolveWorkflowIdForRun(withUser, (input as { runId: string }).runId);
    if (workflowId) {
      await requireWorkflowAccess(withUser, user, workflowId, { write: WRITE_TOOLS.has(name) });
    }
  }

  const output = await tool.handler({ withUser, user, pendingActionId: opts.pendingActionId }, input);
  const summary = tool.summarize(output, input);
  const render = tool.render(output, input);

  const workflowId = typeof (input as { workflowId?: unknown }).workflowId === "string" ? (input as { workflowId: string }).workflowId : null;
  await auditToolCall(withUser, user, { tool: name, tier: tool.tier, workflowId, summary });

  return { summary, render };
}
