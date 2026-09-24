import { z } from "zod";
import { EntityRef } from "@nia/schemas";
import { getConnectionSchema } from "../../services/connections.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ connectionId: z.string().uuid(), entity: EntityRef });
type Input = z.infer<typeof InputSchema>;
type Output = { blocked: boolean; statement: string | null };

/**
 * Copilot agent (Part 5). Read-tier explanation only. The postgres/supabase
 * connectors' /introspect already computes rlsBlocksRead/rlsFixSql per
 * entity (services/connector-supabase/src/rlsSql.ts's
 * buildIntrospectPrivilegeSql, surfaced on IntrospectResponse.entities —
 * packages/schemas/src/contract.ts) — this tool is a thin lookup over data
 * describe_source already exposes, not a new privileged path or a new
 * connector code path. Never runs the statement; the user applies it
 * themselves against their own database.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "explain_source_rls_policy",
  description: "Checks whether a source table has RLS enabled with no policy for Nia's role, and if so, shows the exact CREATE POLICY statement to fix it. The user must run it themselves.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const schema = await getConnectionSchema(ctx.withUser, ctx.user.scope, input.connectionId);
    const entity = schema.entities.find((e) => e.namespace === input.entity.namespace && e.name === input.entity.name);
    if (!entity) throw new AppError(404, "ENTITY_NOT_FOUND", `Entity ${input.entity.namespace}.${input.entity.name} not found in this connection's schema.`);
    return { blocked: entity.rlsBlocksRead === true, statement: entity.rlsFixSql ?? null };
  },
  summarize: (output, input) =>
    output.blocked && output.statement
      ? `${input.entity.namespace}.${input.entity.name} has RLS enabled with no policy for Nia's role. Run this to fix it: ${output.statement}`
      : `${input.entity.namespace}.${input.entity.name} has no RLS-blocking issue for Nia's role.`,
  render: (output) => ({ kind: "rls_policy_statement", payload: output }),
};

registerTool(tool);
