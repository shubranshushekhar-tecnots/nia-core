import { z } from "zod";
import { getRunStatus } from "../../services/runs.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), runId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof getRunStatus>>;

/**
 * Copilot agent (Part 2, read tier). Backs "how's my run going" — a plain,
 * cheap Postgres read of the persisted workflow_runs row, so it works
 * whether or not anyone still has the run's SSE stream open.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "get_run_status",
  description: "Gets a single run's current persisted status, rows processed, duration, and timestamps.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => getRunStatus(ctx.withUser, ctx.user.scope, input.workflowId, input.runId),
  summarize: (output) =>
    `Run ${output.id}: ${output.status}, ${output.rowsProcessed} rows processed${output.durationMs != null ? `, ${output.durationMs}ms` : ""}, started ${output.startedAt}${output.finishedAt ? `, finished ${output.finishedAt}` : ""}.`,
  render: (output) => ({ kind: "run_status", payload: output }),
};

registerTool(tool);
