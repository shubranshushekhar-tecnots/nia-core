import { workspaceWhere } from "@nia/db";
import { CONNECTOR_MANIFESTS, getConnectorManifest, type Operation, type Capability } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import type { WithUser } from "../lib/withUser.js";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

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

type ConnectorInstallRow = { id: string; connector_id: string; installed_by_user_id: string; installed_at: string };

export async function listConnectorInstalls(withUser: WithUser, scope: WorkspaceScope): Promise<ConnectorInstall[]> {
  const where = workspaceWhere(scope, 1);
  const { rows } = await withUser((db) =>
    db.query<ConnectorInstallRow>(
      `select id, connector_id, installed_by_user_id, installed_at
       from connector_installs
       where ${where.sql}
       order by installed_at desc`,
      where.params,
    ),
  );

  return rows.map((row) => ({
    id: row.id,
    connectorId: row.connector_id,
    installedByUserId: row.installed_by_user_id,
    installedAt: row.installed_at,
  }));
}

export async function installConnector(
  withUser: WithUser,
  scope: WorkspaceScope,
  installedByUserId: string,
  connectorId: string,
): Promise<ConnectorInstall> {
  if (!getConnectorManifest(connectorId)) {
    throw new AppError(400, "UNKNOWN_CONNECTOR", `No manifest for connector "${connectorId}".`);
  }

  const orgId = "orgId" in scope ? scope.orgId : null;
  const ownerId = "orgId" in scope ? null : scope.ownerId;

  try {
    const { rows } = await withUser((db) =>
      db.query<ConnectorInstallRow>(
        `insert into connector_installs (org_id, owner_id, connector_id, installed_by_user_id)
         values ($1, $2, $3, $4)
         returning id, connector_id, installed_by_user_id, installed_at`,
        [orgId, ownerId, connectorId, installedByUserId],
      ),
    );
    const data = rows[0]!;
    return {
      id: data.id,
      connectorId: data.connector_id,
      installedByUserId: data.installed_by_user_id,
      installedAt: data.installed_at,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "ALREADY_INSTALLED", `"${connectorId}" is already installed.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "INSTALL_FAILED", message);
  }
}

/**
 * Route-level guard, not RLS: refuses uninstall while any connection in
 * this scope still references the connector. There is no FK from
 * connections.connector_id to connector_installs (manifests are files —
 * see 0007's header comment), so RLS has no way to enforce this; a missing
 * guard here is a real bug, not a nicety.
 */
export async function uninstallConnector(withUser: WithUser, scope: WorkspaceScope, installId: string): Promise<void> {
  const installWhere = workspaceWhere(scope, 2);
  const { rows: installRows } = await withUser((db) =>
    db.query<{ id: string; connector_id: string }>(
      `select id, connector_id from connector_installs where id = $1 and ${installWhere.sql}`,
      [installId, ...installWhere.params],
    ),
  );
  const install = installRows[0];
  if (!install) throw new AppError(404, "NOT_FOUND", "Connector install not found.");

  const inUseWhere = workspaceWhere(scope, 2);
  const { rows: inUseRows } = await withUser((db) =>
    db.query<{ count: number }>(
      `select count(*)::int as count from connections where connector_id = $1 and ${inUseWhere.sql}`,
      [install.connector_id, ...inUseWhere.params],
    ),
  );
  const count = inUseRows[0]?.count ?? 0;
  if (count > 0) {
    throw new AppError(
      409,
      "CONNECTOR_IN_USE",
      `Cannot uninstall "${install.connector_id}" while ${count} connection(s) still use it.`,
    );
  }

  try {
    const deleteWhere = workspaceWhere(scope, 2);
    await withUser((db) =>
      db.query(`delete from connector_installs where id = $1 and ${deleteWhere.sql}`, [installId, ...deleteWhere.params]),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "UNINSTALL_FAILED", message);
  }
}
