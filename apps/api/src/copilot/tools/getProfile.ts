import { z } from "zod";
import { EntityRef } from "@nia/schemas";
import { getConnectionProfile } from "../../services/connections.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ connectionId: z.string().uuid(), entity: EntityRef });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof getConnectionProfile>>;

/**
 * Copilot agent (Part 2, read tier). Thin passthrough to getConnectionProfile
 * (Profile tab's read path — cached, 24h TTL, never blocks on a fresh
 * sample unless the schema drifted). triggeredByUserId comes from the
 * acting user, same as every other user-attributed write in this codebase.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "get_profile",
  description: "Gets column statistics (types, null/empty counts, distinct counts) for one entity on a connection.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => getConnectionProfile(ctx.withUser, ctx.user.scope, input.connectionId, input.entity, ctx.user.userId),
  summarize: (output, input) => {
    const cols = output.columns.map(
      (c) => `${c.name} (${c.declaredType}, ${c.nullCount}/${c.sampleCount} null, ${c.distinctCount} distinct)`,
    );
    return `Profile of ${input.entity.namespace}.${input.entity.name} (${output.sampleMethod}, sample size ${output.sampleSize}): ${cols.join("; ")}`;
  },
  render: (output) => ({ kind: "entity_profile", payload: output }),
};

registerTool(tool);
