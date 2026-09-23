import { z } from "zod";
import { EntityRef, buildGrantStatementText } from "@nia/schemas";
import { getConnection, getConnectionSchema } from "../../services/connections.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ connectionId: z.string().uuid(), entity: EntityRef });
type Input = z.infer<typeof InputSchema>;
type Output = { missingPrivilege: boolean; statement: string | null };

/**
 * Copilot agent (Part 5). Deviation, documented in docs/decisions.md: the
 * plan describes this as reacting to a live /preflight failure, but no
 * apps/api-side caller of a connector's /preflight endpoint exists (only
 * apps/worker calls it, at live-run time, with its service-role client —
 * a path this tool must never use). Scoped down to reuse the same signal
 * describe_source already surfaces (IntrospectResponse.entities[].canWrite,
 * populated by /introspect, not /preflight) plus the same pure DDL builder
 * explain_write_grant uses, rather than adding a new connector-dispatch
 * code path from apps/api just for this one tool. Same never-runs-it,
 * user-confirms-it-themselves contract as explain_write_grant.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "explain_missing_privilege",
  description: "Checks whether Nia's role can write to a specific source/destination entity, and if not, shows the exact GRANT statement needed. The user must run it themselves.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const [connection, schema] = await Promise.all([
      getConnection(ctx.supabase, ctx.user.scope, input.connectionId),
      getConnectionSchema(ctx.supabase, ctx.user.scope, input.connectionId),
    ]);
    if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");
    const entity = schema.entities.find((e) => e.namespace === input.entity.namespace && e.name === input.entity.name);
    if (!entity) throw new AppError(404, "ENTITY_NOT_FOUND", `Entity ${input.entity.namespace}.${input.entity.name} not found in this connection's schema.`);

    if (entity.canWrite !== false) return { missingPrivilege: false, statement: null };

    const roleUser = `nia_write_${Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const rolePassword = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const statement = buildGrantStatementText(connection.connectorId, input.entity.namespace, roleUser, rolePassword);
    return { missingPrivilege: true, statement };
  },
  summarize: (output, input) =>
    output.missingPrivilege
      ? `Nia's role can't currently write to ${input.entity.namespace}.${input.entity.name}.${output.statement ? ` Run this to grant it: ${output.statement}` : ""}`
      : `Nia's role already has write access to ${input.entity.namespace}.${input.entity.name}.`,
  render: (output) => ({ kind: "missing_privilege_statement", payload: output }),
};

registerTool(tool);
