import { z } from "zod";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ runId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = { run: unknown };

/**
 * Copilot agent (Part 2). Plan: "cancel_run needs no confirmation, since it
 * only stops work and staging keeps the destination intact." Tier "edit"
 * (not "execute") specifically to get that no-confirmation gating — the
 * confirmation requirement in this codebase is per-tool (start_run builds
 * its own pending action inside its handler), not a blanket property of a
 * tier name, so "edit" is the correct, deliberate choice here, not a
 * mis-tiering. Same cancel_workflow_run RPC the manual cancel button calls
 * (routes/runs.ts) — the RPC's own org-membership check is the real
 * authorization, same as that route.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "cancel_run",
  description: "Cancels a running workflow run. No confirmation needed.",
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const { data, error } = await ctx.supabase.rpc("cancel_workflow_run", { p_run_id: input.runId });
    if (error) throw new AppError(409, "CANCEL_FAILED", error.message);
    return { run: data };
  },
  summarize: () => "Run cancelled.",
  render: (output) => ({ kind: "run_cancelled", payload: output }),
};

registerTool(tool);
