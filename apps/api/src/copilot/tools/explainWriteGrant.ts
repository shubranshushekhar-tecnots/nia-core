import { z } from "zod";
import { buildGrantStatementText } from "@nia/schemas";
import { getConnection } from "../../services/connections.js";
import { AppError } from "../../lib/appError.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ connectionId: z.string().uuid(), namespace: z.string() });
type Input = z.infer<typeof InputSchema>;
type Output = { connectorId: string; namespace: string; roleUser: string; statement: string };

/** Same style as NodeDrawer.tsx's randomWriteRoleUser/randomWriteRolePassword — a suggested, not-yet-real value shown before the user runs anything. Not a secret; the real credential only exists once the user runs this DDL against their own database and confirms it through the existing grant panel. */
function randomWriteRoleUser(): string {
  return `nia_write_${randomHex(8)}`;
}
function randomWriteRolePassword(): string {
  return randomHex(32);
}
function randomHex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/**
 * Copilot agent (Part 5). Read-tier explanation only — this never mints or
 * confirms a grant (both stay exclusively in the existing GrantAccessPanel
 * UI, per the plan's "the user runs the DDL and confirms it themselves").
 * Reuses the exact same pure DDL-text builder
 * (packages/schemas/src/writeGrantStatement.ts) the drawer's grant panel
 * calls, so the statement Copilot shows is always identical in shape to
 * what the UI would generate.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "explain_write_grant",
  description: "Explains and shows the exact CREATE ROLE/GRANT statement needed to give Nia write access to a namespace on a connection. The user must run it and confirm it themselves in the connection's grant panel — this tool never runs or confirms it.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx, input) => {
    const connection = await getConnection(ctx.supabase, ctx.user.scope, input.connectionId);
    if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");
    const roleUser = randomWriteRoleUser();
    const statement = buildGrantStatementText(connection.connectorId, input.namespace, roleUser, randomWriteRolePassword());
    if (!statement) throw new AppError(400, "UNSUPPORTED_CONNECTOR", `No grant statement available for connector "${connection.connectorId}".`);
    return { connectorId: connection.connectorId, namespace: input.namespace, roleUser, statement };
  },
  summarize: (output) =>
    `To grant Nia write access to "${output.namespace}", run this on the connection's database, then confirm it in the connection's grant panel: ${output.statement}`,
  render: (output) => ({ kind: "write_grant_statement", payload: output }),
};

registerTool(tool);
