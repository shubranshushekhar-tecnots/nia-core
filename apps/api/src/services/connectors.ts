import type { SupabaseClient } from "@supabase/supabase-js";
import { CONNECTOR_MANIFESTS, getConnectorManifest, type Operation, type Capability } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";

export type ConnectorCatalogEntry = {
  id: string;
  name: string;
  category: string;
  version: string;
  // Added for the builder canvas node palette (0012_workflow_graphs.sql
  // era): the palette needs to know what a manifest can DO to classify it
  // as a source/destination candidate and to know which control verbs need
  // a write-grant lock badge, without ever hardcoding a per-tool list
  // client-side. Kept off the wire for every other existing caller
  // (connections settings UI etc.) that only reads id/name/category/version.
  operations: Operation[];
  capabilities: Capability[];
};

/** Static — manifests are files, not rows (0007_connectors.sql's header comment). */
export function getConnectorCatalog(): ConnectorCatalogEntry[] {
  return Object.values(CONNECTOR_MANIFESTS).map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    version: m.version,
    operations: m.operations,
    capabilities: m.capabilities,
  }));
}

export type ConnectorInstall = {
  id: string;
  connectorId: string;
  installedByUserId: string;
  installedAt: string;
};

export async function listConnectorInstalls(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
): Promise<ConnectorInstall[]> {
  let query = supabase
    .from("connector_installs")
    .select("id, connector_id, installed_by_user_id, installed_at");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("installed_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id,
    connectorId: row.connector_id,
    installedByUserId: row.installed_by_user_id,
    installedAt: row.installed_at,
  }));
}

export async function installConnector(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  installedByUserId: string,
  connectorId: string,
): Promise<ConnectorInstall> {
  if (!getConnectorManifest(connectorId)) {
    throw new AppError(400, "UNKNOWN_CONNECTOR", `No manifest for connector "${connectorId}".`);
  }

  const { data, error } =
    "orgId" in scope
      ? await supabase
          .from("connector_installs")
          .insert({ org_id: scope.orgId, owner_id: null, connector_id: connectorId, installed_by_user_id: installedByUserId })
          .select("id, connector_id, installed_by_user_id, installed_at")
          .single()
      : await supabase
          .from("connector_installs")
          .insert({ org_id: null, owner_id: scope.ownerId, connector_id: connectorId, installed_by_user_id: installedByUserId })
          .select("id, connector_id, installed_by_user_id, installed_at")
          .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError(409, "ALREADY_INSTALLED", `"${connectorId}" is already installed.`);
    }
    throw new AppError(500, "INSTALL_FAILED", error.message);
  }

  return {
    id: data.id,
    connectorId: data.connector_id,
    installedByUserId: data.installed_by_user_id,
    installedAt: data.installed_at,
  };
}

/**
 * Route-level guard, not RLS: refuses uninstall while any connection in
 * this scope still references the connector. There is no FK from
 * connections.connector_id to connector_installs (manifests are files —
 * see 0007's header comment), so RLS has no way to enforce this; a missing
 * guard here is a real bug, not a nicety.
 */
export async function uninstallConnector(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  installId: string,
): Promise<void> {
  let installQuery = supabase.from("connector_installs").select("id, connector_id").eq("id", installId);
  installQuery =
    "orgId" in scope ? installQuery.eq("org_id", scope.orgId) : installQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: install } = await installQuery.maybeSingle();
  if (!install) throw new AppError(404, "NOT_FOUND", "Connector install not found.");

  let inUseQuery = supabase
    .from("connections")
    .select("id", { count: "exact", head: true })
    .eq("connector_id", install.connector_id);
  inUseQuery =
    "orgId" in scope ? inUseQuery.eq("org_id", scope.orgId) : inUseQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await inUseQuery;
  if (count && count > 0) {
    throw new AppError(
      409,
      "CONNECTOR_IN_USE",
      `Cannot uninstall "${install.connector_id}" while ${count} connection(s) still use it.`,
    );
  }

  let deleteQuery = supabase.from("connector_installs").delete().eq("id", installId);
  deleteQuery =
    "orgId" in scope ? deleteQuery.eq("org_id", scope.orgId) : deleteQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { error } = await deleteQuery;
  if (error) throw new AppError(500, "UNINSTALL_FAILED", error.message);
}
