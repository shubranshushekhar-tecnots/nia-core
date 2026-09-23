import { z } from "zod";
import { previewWorkflowDestination } from "../../services/preview.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), destNodeId: z.string() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof previewWorkflowDestination>>;

/**
 * Copilot agent (Part 2, read tier). Thin passthrough to
 * previewWorkflowDestination. Data-minimization boundary (plan Part 4):
 * the model's summary gets row COUNT, column names/types only — never the
 * actual row values. The full rows are only in `render`'s payload, which
 * the UI renders directly and never sends back to the model.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "preview_rows",
  description: "Runs a read-only preview of a destination node and returns column names/types and a row count. Row contents are shown to the user in the UI, not returned to the model.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => previewWorkflowDestination(ctx.supabase, ctx.user.scope, input.workflowId, input.destNodeId, ctx.user.userId),
  summarize: (output) => {
    const columns = output.columns.map((c) => `${c.name} (${c.type})`);
    return `Preview: ${output.rows.length} row(s), columns: ${columns.join(", ")}.`;
  },
  render: (output) => ({ kind: "preview_rows", payload: output }),
};

registerTool(tool);
