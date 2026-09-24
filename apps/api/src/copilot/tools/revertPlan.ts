import { z } from "zod";
import { revertPlan } from "../../services/copilotDiffApply.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), appliedPlanId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof revertPlan>>;

/**
 * Copilot agent (Part 2, edit tier). Direct passthrough to revertPlan —
 * same "Undo" affordance the drawer exposes on any applied plan. Refuses
 * (via the service's own checkRevertConflicts) if the live graph no longer
 * matches what the original plan touched.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "revert_plan",
  description: "Reverts a previously applied change_graph/propose_cleaning/set_destination/propose_mapping plan by its applied-plan id.",
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) => revertPlan(ctx.withUser, ctx.user.scope, input.workflowId, input.appliedPlanId, {}),
  summarize: (output) => `Reverted, graph is now at version ${output.version}.`,
  render: (output) => ({ kind: "graph_applied", payload: output }),
};

registerTool(tool);
