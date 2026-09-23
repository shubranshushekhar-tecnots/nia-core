import { z } from "zod";
import { listRunsForWorkflow } from "../../services/runs.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof listRunsForWorkflow>>[number] | null;

/**
 * Copilot agent (Part 2, read tier). Finds the workflow's most recent
 * failed run. Same deviation as get_run_result: workflow_runs has no
 * persisted failure-message column, so this can only point at WHICH run
 * failed and its counters — never the original free-text error, which is
 * only ever streamed live over the run's SSE connection and never
 * persisted (see apps/worker/src/lib/etl/runEtl.ts's fail()/
 * publishRunEvent). Suggests the run's log panel as the next step, per
 * the plan's "suggest the next step where one exists" requirement.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "explain_last_error",
  description: "Finds the most recent failed run for a workflow and reports what's known about it. The original error message is only available live in the run's log panel, not after the fact.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const runs = await listRunsForWorkflow(ctx.supabase, ctx.user.scope, input.workflowId);
    return runs.find((r) => r.status === "failed") ?? null;
  },
  summarize: (output) =>
    output
      ? `The most recent failed run is ${output.id} (started ${output.startedAt}, ${output.rowsProcessed} rows processed before failing). The original error text isn't persisted — it was only shown live in that run's log panel while it was running. Suggest opening the workflow's run history for any details captured there.`
      : "No failed runs found for this workflow.",
  render: (output) => ({ kind: "last_error", payload: output }),
};

registerTool(tool);
