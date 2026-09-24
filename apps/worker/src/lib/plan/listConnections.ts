import { manifestDialect, type SourceDialect } from "@nia/schemas";
import { withServiceRole, workspaceWhere, type WorkspaceScope } from "@nia/db";
import { dbPool } from "../dbPool.js";

export type VisibleConnection = {
  id: string;
  handle: string;
  connectorId: string;
  dialect: SourceDialect | null;
};

type ConnectionRow = { id: string; connector_id: string; handle: string };

/**
 * Lists every connection visible in `scope` — the plan engine's equivalent
 * of resolveConnection.ts for a LIST instead of a single fetch, same
 * mandatory WorkspaceScope filter for the same reason (see that file's
 * header comment: this runs as service_role (withServiceRole), so this
 * filter is the only thing standing between "the worker listed someone
 * else's connections" and "the worker correctly scoped the list"). Feeds
 * two things: the candidate-connection context generatePlanNode gives the
 * model, and checkConnectionsNode's closed-world check that a proposed
 * connectionId is actually in this list — never trusting a model-emitted
 * connectionId just because it looks like a UUID.
 */
export async function listVisibleConnections(scope: WorkspaceScope): Promise<VisibleConnection[]> {
  const where = workspaceWhere(scope, 1);
  const result = await withServiceRole(dbPool, (db) =>
    db.query<ConnectionRow>(`select id, connector_id, handle from public.connections where ${where.sql}`, [...where.params]),
  );
  return result.rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    connectorId: row.connector_id,
    dialect: manifestDialect(row.connector_id),
  }));
}
