import { z } from "zod";
import { EntityRef, DestinationWriteMode } from "@nia/schemas";
import { getWorkflowGraph } from "../../services/workflowGraphs.js";
import { applyPlanDiff } from "../../services/copilotDiffApply.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({
  workflowId: z.string().uuid(),
  nodeId: z.string(),
  connectionId: z.string().uuid().optional(),
  entity: EntityRef.optional(),
  writeMode: DestinationWriteMode.optional(),
});
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof applyPlanDiff>>;

/**
 * Copilot agent (Part 2, edit tier). Builds a single updateNode PlanDiff op
 * for a destination node's connection/entity/writeMode and applies it
 * through the same applyPlanDiff path change_graph uses — this is not a
 * new privileged path, just a narrower, purpose-built wrapper so the model
 * doesn't have to construct a full before/after GraphNode diff by hand for
 * this one common case. Fresh-fetches the current graph (never trusts a
 * cached one) so baseGraphVersion/before are always accurate.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "set_destination",
  description: "Sets a destination node's connection, target entity (table/collection), and/or write mode.",
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const current = await getWorkflowGraph(ctx.withUser, ctx.user.scope, input.workflowId);
    const before = current.graph.nodes.find((n) => n.id === input.nodeId);
    if (!before) throw new AppError(404, "NOT_FOUND", "Node not found in this workflow's graph.");

    const after = {
      ...before,
      connectionId: input.connectionId ?? before.connectionId,
      config: {
        ...before.config,
        ...(input.entity ? { entity: input.entity } : {}),
        ...(input.writeMode ? { writeMode: input.writeMode } : {}),
      },
    };

    return applyPlanDiff(ctx.withUser, ctx.user.scope, input.workflowId, {
      diff: {
        summary: `Set destination for node ${input.nodeId}`,
        baseGraphVersion: current.version,
        ops: [{ kind: "updateNode", nodeId: input.nodeId, before, after }],
      },
    });
  },
  summarize: (output) => `Destination updated, graph is now at version ${output.version}.`,
  render: (output) => ({ kind: "graph_applied", payload: output }),
};

registerTool(tool);
