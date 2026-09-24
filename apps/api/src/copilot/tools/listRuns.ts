import { z } from "zod";
import { listRunsForWorkflow } from "../../services/runs.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof listRunsForWorkflow>>;

/**
 * Copilot agent (Part 2, read tier). Thin passthrough to
 * listRunsForWorkflow (added to services/runs.ts this task — plain
 * RLS-scoped read, same shape as every other list function here, not a
 * new privileged path).
 */
const tool: ToolDefinition<Input, Output> = {
  name: "list_runs",
  description: "Lists the most recent runs of a workflow, most recent first (status, rows processed, duration, timestamps).",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => listRunsForWorkflow(ctx.withUser, ctx.user.scope, input.workflowId),
  summarize: (output) => {
    if (output.length === 0) return "No runs yet for this workflow.";
    const lines = output.map((r) => `${r.id} (${r.status}, ${r.rowsProcessed} rows, started ${r.startedAt})`);
    return `${output.length} run(s): ${lines.join("; ")}`;
  },
  render: (output) => ({ kind: "runs_list", payload: output }),
};

registerTool(tool);
