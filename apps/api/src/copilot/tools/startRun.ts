import { z } from "zod";
import { getWorkflowGraph } from "../../services/workflowGraphs.js";
import { getConnection } from "../../services/connections.js";
import { startWorkflowRun } from "../../services/runs.js";
import { createPendingAction, consumePendingAction } from "../pendingActions.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ workflowId: z.string().uuid(), destNodeIds: z.array(z.string()).min(1) });
type Input = z.infer<typeof InputSchema>;

type ConfirmationCardEntry = {
  destNodeId: string;
  connectionDisplayName: string | null;
  entityNamespace: string | null;
  entityName: string | null;
  writeMode: string;
};

type Output =
  | { status: "needs_confirmation"; pendingActionId: string; card: ConfirmationCardEntry[] }
  | { status: "started"; runs: { destNodeId: string; runId: string }[] };

/**
 * Copilot agent (Part 3 — the plan's one always-confirmed tool).
 *
 * First call, ctx.pendingActionId absent: builds a confirmation card from
 * real, freshly-fetched data (destination connection display names,
 * target entity, write mode — the UI renders THIS, never text the model
 * wrote) and creates a pending action (createPendingAction). Does not
 * start anything yet.
 *
 * Second call, ctx.pendingActionId present — only ever set by the agent
 * loop after the user's own click hit the confirm endpoint
 * (routes/copilotAgent.ts, confirmPendingAction): consumes the pending
 * action first (consumePendingAction — refuses if it isn't confirmed, is
 * expired, or the recomputed args hash doesn't match what was confirmed),
 * then calls the exact same startWorkflowRun the manual "Run" button uses.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "start_run",
  description: "Starts a workflow run against one or more destination nodes. Always requires the user to confirm a confirmation card before anything actually runs.",
  tier: "execute",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    if (!ctx.pendingActionId) {
      const graph = await getWorkflowGraph(ctx.supabase, ctx.user.scope, input.workflowId);
      const card: ConfirmationCardEntry[] = [];
      for (const destNodeId of input.destNodeIds) {
        const node = graph.graph.nodes.find((n) => n.id === destNodeId);
        if (!node) throw new AppError(404, "NOT_FOUND", `Node ${destNodeId} not found in this workflow's graph.`);
        const connection = node.connectionId ? await getConnection(ctx.supabase, ctx.user.scope, node.connectionId) : null;
        const config = node.config as { entity?: { namespace: string; name: string }; writeMode?: string };
        card.push({
          destNodeId,
          connectionDisplayName: connection?.displayName ?? null,
          entityNamespace: config.entity?.namespace ?? null,
          entityName: config.entity?.name ?? null,
          writeMode: config.writeMode ?? "staged",
        });
      }
      const pending = await createPendingAction(ctx.supabase, input.workflowId, "start_run", input);
      return { status: "needs_confirmation", pendingActionId: pending.id, card };
    }

    await consumePendingAction(ctx.supabase, ctx.pendingActionId, "start_run", input);
    const result = await startWorkflowRun(ctx.supabase, ctx.user.scope, input.workflowId, input.destNodeIds, ctx.user.userId);
    return { status: "started", runs: result.runs };
  },
  summarize: (output) =>
    output.status === "needs_confirmation"
      ? `This run needs your confirmation before it starts: ${output.card.map((c) => `${c.destNodeId} -> ${c.connectionDisplayName ?? "unknown connection"}.${c.entityNamespace ?? "?"}.${c.entityName ?? "?"} (${c.writeMode} write mode)`).join("; ")}`
      : `Started ${output.runs.length} run(s): ${output.runs.map((r) => r.runId).join(", ")}.`,
  render: (output) =>
    output.status === "needs_confirmation" ? { kind: "run_confirmation", payload: output } : { kind: "runs_started", payload: output },
};

registerTool(tool);
