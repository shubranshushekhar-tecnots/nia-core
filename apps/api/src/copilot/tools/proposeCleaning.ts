import { z } from "zod";
import { proposeCleaningForWorkflow } from "../../services/cleanPropose.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), nodeId: z.string() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof proposeCleaningForWorkflow>>;

/**
 * Copilot agent (Part 2, edit tier — "reversible" per the plan because
 * nothing here is auto-applied). Direct passthrough to
 * proposeCleaningForWorkflow, the same worker-backed flow the drawer's
 * "Propose cleaning" button uses. The returned proposal is shown to the
 * user as a ghost preview; applying it (the optional cleanBinding on
 * change_graph/applyPlanDiff) is a separate, explicit step this tool
 * never takes on its own.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "propose_cleaning",
  description: "Proposes a data-cleaning plan for a node's source data. Returns a diff for the user to review; does not apply anything.",
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) => proposeCleaningForWorkflow(ctx.supabase, ctx.user.scope, input.workflowId, input.nodeId, ctx.user.userId),
  summarize: (output) => `Cleaning proposal: ${output.diff.summary} (specialists: ${[...new Set(output.columns.map((c) => c.specialist))].join(", ")}).`,
  render: (output) => ({ kind: "cleaning_proposal", payload: output }),
};

registerTool(tool);
