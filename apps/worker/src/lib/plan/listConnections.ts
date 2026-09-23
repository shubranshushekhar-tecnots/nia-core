import { manifestDialect, type SourceDialect } from "@nia/schemas";
import { supabase } from "../supabaseClient.js";
import type { WorkspaceScope } from "../workspaceScope.js";

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
 * header comment: `supabase` here is the service_role client, so this
 * filter is the only thing standing between "the worker listed someone
 * else's connections" and "the worker correctly scoped the list"). Feeds
 * two things: the candidate-connection context generatePlanNode gives the
 * model, and checkConnectionsNode's closed-world check that a proposed
 * connectionId is actually in this list — never trusting a model-emitted
 * connectionId just because it looks like a UUID.
 */
export async function listVisibleConnections(scope: WorkspaceScope): Promise<VisibleConnection[]> {
  let query = supabase.from("connections").select("id, connector_id, handle");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.returns<ConnectionRow[]>();
  return (data ?? []).map((row) => ({
    id: row.id,
    handle: row.handle,
    connectorId: row.connector_id,
    dialect: manifestDialect(row.connector_id),
  }));
}
