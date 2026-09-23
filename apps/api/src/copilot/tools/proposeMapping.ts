import { z } from "zod";
import { proposeMappingForWorkflow } from "../../services/mappings.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), destNodeId: z.string() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof proposeMappingForWorkflow>>;

/**
 * Copilot agent (Part 2, edit tier — reversible because nothing here is
 * auto-applied). Direct passthrough to proposeMappingForWorkflow. The
 * returned proposal is only ever applied via the existing, separate
 * PUT /:id/graph call the drawer issues when the user clicks Approve —
 * same no-persistence shape as propose_cleaning.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "propose_mapping",
  description: "Proposes field mappings from source to a destination node. Returns entries for the user to review; does not apply anything.",
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) => proposeMappingForWorkflow(ctx.supabase, ctx.user.scope, input.workflowId, input.destNodeId, ctx.user.userId),
  summarize: (output) =>
    output.entries.length === 0
      ? "No mapping entries proposed."
      : `${output.entries.length} mapping entry(ies) proposed.`,
  render: (output) => ({ kind: "mapping_proposal", payload: output }),
};

registerTool(tool);
