import { withServiceRole, workspaceWhere, type WorkspaceScope } from "@nia/db";
import { getConnectorManifest, type ConnectorManifest, type CredentialRef } from "@nia/schemas";
import { dbPool } from "./dbPool.js";
import type { DispatchResult } from "./errors.js";

export type ResolvedConnection = {
  id: string;
  connectorId: string;
  handle: string;
  config: Record<string, unknown>;
  ownerUserId: string;
  credential: CredentialRef;
  manifest: ConnectorManifest;
};

type ConnectionRow = {
  id: string;
  connector_id: string;
  handle: string;
  config: Record<string, unknown>;
  vault_secret_ref: string;
  cred_version: number;
  owner_user_id: string;
};

/**
 * Resolves a connectionId to everything dispatch.ts needs — mirrors
 * apps/api/src/services/connections.ts's getConnection/testConnection query
 * shape exactly: `scope` is ANDed into the same select as `id`, so a
 * connection that exists but belongs to a different org/owner simply never
 * matches the query and comes back as "not found," identical to an id that
 * doesn't exist at all.
 *
 * This is deliberate, not incidental: this runs as service_role
 * (@nia/db's withServiceRole, see supabaseClient.ts's header comment on
 * what that bypasses), which bypasses RLS entirely — this scope filter
 * (workspaceWhere) is the ONLY thing standing between "the worker
 * resolved someone else's connection" and "the worker correctly refused
 * it." `scope` is mandatory, not optional and never defaulted, so this
 * check can never be silently skipped by a caller.
 */
export async function resolveConnection(
  connectionId: string,
  scope: WorkspaceScope,
): Promise<DispatchResult<ResolvedConnection>> {
  const where = workspaceWhere(scope, 2);
  const result = await withServiceRole(dbPool, (db) =>
    db.query<ConnectionRow>(
      `select id, connector_id, handle, config, vault_secret_ref, cred_version, owner_user_id
       from public.connections
       where id = $1 and ${where.sql}`,
      [connectionId, ...where.params],
    ),
  );
  const data = result.rows[0] ?? null;
  if (!data) {
    return {
      ok: false,
      error: {
        kind: "connection-not-found",
        message: `Connection ${connectionId} not found in the given scope.`,
      },
    };
  }

  const manifest = getConnectorManifest(data.connector_id);
  if (!manifest) {
    // Should not happen in practice: connections.connector_id can only be
    // set by apps/api's createConnection, which already requires a manifest
    // to exist. Treated as service-error (a data-integrity/config problem),
    // not connection-not-found — the row genuinely exists and is in scope.
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `No manifest registered for connector "${data.connector_id}".`,
      },
    };
  }

  return {
    ok: true,
    value: {
      id: data.id,
      connectorId: data.connector_id,
      handle: data.handle,
      config: data.config,
      ownerUserId: data.owner_user_id,
      credential: {
        connectionId: data.id,
        credVersion: data.cred_version,
        vaultRef: data.vault_secret_ref,
      },
      manifest,
    },
  };
}
