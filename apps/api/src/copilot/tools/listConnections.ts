import { z } from "zod";
import { listConnections } from "../../services/connections.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof listConnections>>;

/**
 * Copilot agent (docs/plans/copilot-agent.md, Part 2, read tier). Thin
 * passthrough to the existing listConnections service — the same function
 * the Connections page itself calls, through the caller's own RLS-scoped
 * client. No confirmation needed (read tier).
 */
const tool: ToolDefinition<Input, Output> = {
  name: "list_connections",
  description: "Lists every connection in the current workspace (org or personal), with connector, display name, and last test status.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx) => listConnections(ctx.supabase, ctx.user.scope),
  summarize: (output) =>
    output.length === 0
      ? "No connections exist in this workspace yet."
      : `${output.length} connection(s): ${output.map((c) => `${c.displayName} (${c.connectorId}, ${c.lastTestStatus ?? "untested"})`).join("; ")}`,
  render: (output) => ({ kind: "connections_list", payload: output }),
};

registerTool(tool);
