import { z } from "zod";
import { getWorkflowDetail } from "../../services/workflows.js";
import { getWorkflowGraph } from "../../services/workflowGraphs.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = {
  detail: NonNullable<Awaited<ReturnType<typeof getWorkflowDetail>>>;
  graph: Awaited<ReturnType<typeof getWorkflowGraph>>;
};

/**
 * Copilot agent (Part 2, read tier). Combines the same two reads the
 * canvas page itself makes on load (workflow detail + its current
 * PlanDiff-addressable graph) so the model can reference real node ids
 * before proposing change_graph/set_destination ops.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "get_workflow",
  description: "Gets a workflow's detail (name, status, project) and its current graph (nodes, edges, version) by workflow id.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const detail = await getWorkflowDetail(ctx.supabase, input.workflowId, ctx.user.scope);
    if (!detail) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
    const graph = await getWorkflowGraph(ctx.supabase, ctx.user.scope, input.workflowId);
    return { detail, graph };
  },
  summarize: (output) => {
    const nodes = output.graph.graph.nodes.map((n) => `${n.id} (${n.type}${n.manifestId ? `, ${n.manifestId}` : ""})`);
    return `Workflow "${output.detail.name}" (${output.detail.status}) in project "${output.detail.project.name}", graph version ${output.graph.version}. Nodes: ${nodes.length === 0 ? "none" : nodes.join("; ")}. Edges: ${output.graph.graph.edges.length}.`;
  },
  render: (output) => ({ kind: "workflow_detail", payload: output }),
};

registerTool(tool);
