import { z } from "zod";
import { getConnectionSchema } from "../../services/connections.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ connectionId: z.string().uuid() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof getConnectionSchema>>;

/**
 * Copilot agent (Part 2, read tier). Thin passthrough to getConnectionSchema
 * (the same introspection the canvas's field pickers use). Summary lists
 * entity names and field counts only — full field lists (names/types) are
 * in the render payload for the UI, kept out of the summary to avoid
 * blowing up the model's context on wide schemas.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "describe_source",
  description: "Describes a connection's introspected schema: entities (tables/collections), their fields, and read/write access.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => getConnectionSchema(ctx.withUser, ctx.user.scope, input.connectionId),
  summarize: (output) => {
    if (output.entities.length === 0) return "This connection's schema has no entities.";
    const lines = output.entities.map((e) => {
      const flags = [e.canRead === false ? "no read access" : null, e.canWrite === false ? "no write access" : null, e.rlsBlocksRead ? "RLS blocks read" : null]
        .filter(Boolean)
        .join(", ");
      return `${e.namespace}.${e.name} (${e.fields.length} field(s)${flags ? `, ${flags}` : ""})`;
    });
    return `${output.entities.length} entity(ies): ${lines.join("; ")}`;
  },
  render: (output) => ({ kind: "source_schema", payload: output }),
};

registerTool(tool);
