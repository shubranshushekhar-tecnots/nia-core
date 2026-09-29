import { z } from "zod";
import { listRunsForWorkflow } from "../../services/runs.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof listRunsForWorkflow>>[number] | null;

/**
 * Copilot agent (Part 2, read tier). Finds the workflow's most recent
 * failed run and reports its persisted error message, if one was
 * captured. Prior to Console v1 Slice 3c / supabase/migrations/
 * 0047_workflow_runs_error.sql, workflow_runs had no persisted
 * failure-message column at all — the original text was only ever
 * streamed live over the run's SSE connection (apps/worker/src/lib/etl/
 * runEtl.ts's fail()/publishRunEvent) and lost once that stream closed.
 * A run that failed before this migration still has `error: null` (see
 * services/runs.ts's doc comment) — summarize() falls back to the old
 * "not captured" framing for exactly that case.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "explain_last_error",
  description: "Finds the most recent failed run for a workflow and reports what's known about it, including the persisted error message if one was captured.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const runs = await listRunsForWorkflow(ctx.withUser, ctx.user.scope, input.workflowId);
    return runs.find((r) => r.status === "failed") ?? null;
  },
  summarize: (output) => {
    if (!output) return "No failed runs found for this workflow.";
    const base = `The most recent failed run is ${output.id} (started ${output.startedAt}, ${output.rowsProcessed} rows processed before failing).`;
    return output.error?.message
      ? `${base} Error: ${output.error.message}`
      : `${base} No error message was captured for this run.`;
  },
  render: (output) => ({ kind: "last_error", payload: output }),
};

registerTool(tool);
