import { z } from "zod";
import { getRunStatus } from "../../services/runs.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), runId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof getRunStatus>>;

/**
 * Copilot agent (Part 2, read tier). Deviation, documented in
 * docs/decisions.md: workflow_runs has no persisted failure-message
 * column (apps/worker/src/lib/etl/workflowRuns.ts's finishRun only ever
 * writes status/counters; the real per-failure text is published
 * transiently over Redis via publishRunEvent for the run's SSE stream,
 * never persisted). Once that stream has closed, this tool — and
 * explain_last_error — can only report persisted status/counters, never
 * the original error text. Distinct name from get_run_status (plan lists
 * them as separate tools) but currently the same read; kept as two tools
 * so a future persisted-error-message column only needs to change this
 * file.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "get_run_result",
  description: "Gets a finished run's final status and counters. Note: if the run failed, only the persisted status is available here, not the original error message (that is only ever streamed live while the run's log panel is open).",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => getRunStatus(ctx.withUser, ctx.user.scope, input.workflowId, input.runId),
  summarize: (output) => {
    if (output.status === "running") return `Run ${output.id} is still running (${output.rowsProcessed} rows so far).`;
    const base = `Run ${output.id} ${output.status}: ${output.rowsProcessed} rows processed${output.durationMs != null ? ` in ${output.durationMs}ms` : ""}.`;
    return output.status === "failed" ? `${base} The original error message is not available after the fact — only this final status.` : base;
  },
  render: (output) => ({ kind: "run_result", payload: output }),
};

registerTool(tool);
