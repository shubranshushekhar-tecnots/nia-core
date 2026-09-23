import type { SupabaseClient } from "@supabase/supabase-js";
import { getTool } from "./registry.js";
import { auditToolCall } from "./audit.js";
import { AppError } from "../lib/appError.js";
import type { ActingUser, ToolRender } from "./types.js";

export type ToolCallResult = { summary: string; render: ToolRender };

/**
 * Copilot agent (Part 1/3) — the one place every tool call actually runs
 * through, whether invoked by the agent loop or by the confirm-and-execute
 * path. Validates input against the tool's own schema (never trusts the
 * model's raw JSON), calls the handler with the caller's own RLS-scoped
 * supabase client (never service-role), then unconditionally audits the
 * call (Part 1: "Every tool call is written to the audit log").
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
  supabase: SupabaseClient,
  user: ActingUser,
  name: string,
  rawArgs: unknown,
  opts: { pendingActionId?: string } = {},
): Promise<ToolCallResult> {
  const tool = getTool(name);
  if (!tool) throw new AppError(400, "UNKNOWN_TOOL", `No such tool "${name}".`);

  const input = tool.inputSchema.parse(rawArgs);
  const output = await tool.handler({ supabase, user, pendingActionId: opts.pendingActionId }, input);
  const summary = tool.summarize(output, input);
  const render = tool.render(output, input);

  const workflowId = typeof (input as { workflowId?: unknown }).workflowId === "string" ? (input as { workflowId: string }).workflowId : null;
  await auditToolCall(supabase, user, { tool: name, tier: tool.tier, workflowId, summary });

  return { summary, render };
}
