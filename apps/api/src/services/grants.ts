import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnectorManifest } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { dispatchInvalidate, dispatchTest } from "../lib/connectorDispatch.js";
import { getSecretStore, toSecretScope } from "../lib/secretStore.js";
import { getConnection } from "./connections.js";

export type WriteGrant = {
  id: string;
  connectionId: string;
  grantedByUserId: string;
  scope: Record<string, unknown>;
  grantedAt: string;
  revokedAt: string | null;
  confirmedAt: string | null;
  credVersion: number;
  writeCredentialVaultRef: string | null;
  writeRoleName: string | null;
};

const GRANTS_SELECT =
  "id, connection_id, granted_by_user_id, scope, granted_at, revoked_at, confirmed_at, cred_version, write_credential_vault_ref, write_role_name";

type WriteGrantRow = {
  id: string;
  connection_id: string;
  granted_by_user_id: string;
  scope: Record<string, unknown>;
  granted_at: string;
  revoked_at: string | null;
  confirmed_at: string | null;
  cred_version: number;
  write_credential_vault_ref: string | null;
  write_role_name: string | null;
};

function toWriteGrant(row: WriteGrantRow): WriteGrant {
  return {
    id: row.id,
    connectionId: row.connection_id,
    grantedByUserId: row.granted_by_user_id,
    scope: row.scope,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    confirmedAt: row.confirmed_at,
    credVersion: row.cred_version,
    writeCredentialVaultRef: row.write_credential_vault_ref,
    writeRoleName: row.write_role_name,
  };
}

/**
 * write_grants has no org_id/owner_id of its own (0007_connectors.sql) —
 * scope comes entirely from the parent connection, so every entry point
 * here first loads the connection through the caller's own workspace scope
 * (which is itself RLS-backed) to confirm access before touching grants.
 *
 * create/confirm/revoke go through the RPCs 0016_write_grants.sql shipped
 * (create_write_grant / confirm_write_grant / revoke_write_grant) rather
 * than direct table writes — 0016 revoked direct INSERT/UPDATE on
 * write_grants at both the RLS-policy and table-grant layers, which
 * silently broke this file's original direct .insert()/.update() calls
 * (predated 0016; fixed here as part of Block 2). Each RPC is SECURITY
 * DEFINER and re-derives its own auth check from auth.uid() against the
 * connection's org/owner, so req.supabase must stay the caller's own
 * (user-JWT) client, never a service-role one, for that check to mean
 * anything — and the actor is no longer a caller-supplied param (unlike
 * the old direct insert), it's whatever auth.uid() resolves to inside the
 * RPC.
 */
export async function listWriteGrants(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
): Promise<WriteGrant[]> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const { data } = await supabase
    .from("write_grants")
    .select(GRANTS_SELECT)
    .eq("connection_id", connectionId)
    .order("granted_at", { ascending: false });
  return (data ?? []).map((row) => toWriteGrant(row as WriteGrantRow));
}

export async function createWriteGrant(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
  grantScope: Record<string, unknown>,
): Promise<WriteGrant> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const { data, error } = await supabase.rpc("create_write_grant", {
    p_connection_id: connectionId,
    p_scope: grantScope,
  });
  if (error) throw new AppError(500, "CREATE_FAILED", error.message);
  return toWriteGrant(data as WriteGrantRow);
}

/**
 * Second step: stores the write credential in Vault (same
 * `create_connector_secret` RPC connections.ts's createConnection already
 * uses for read credentials) and attaches the resulting ref. Takes the raw
 * `{ user, password }` credential, not a pre-existing vault ref — the
 * browser never talks to Vault directly, same boundary as connection
 * creation. Fails (RPC raises) if the grant is already confirmed or already
 * revoked — 0016's deliberate non-idempotence; rotation is revoke + create
 * a new grant, not re-confirm.
 *
 * Before confirm_write_grant is ever called, the freshly-stored credential
 * is test-connected (same dispatchTest boundary connections.ts's
 * updateConnection uses — /test only ever accepts a CredentialRef, never
 * raw creds, so "store in Vault, then test" is the only order available).
 * The credVersion passed to dispatchTest is a prediction of what
 * confirm_write_grant's RPC will assign (max existing cred_version for
 * this connection's write_grants, +1 — see
 * 0018_write_grant_cred_version_bump.sql) purely so the pool-manager cache
 * key it produces is shaped consistently; dispatchInvalidate is called
 * unconditionally right after so that ephemeral test pool never lingers
 * (connector-supabase's getPool/getWritePool key formats differ only by a
 * "write:" segment, and evict() strips both by connectionId prefix). A
 * failed test rolls the Vault write back via delete_connector_secret and
 * throws before confirm_write_grant is ever reached — an untested (or
 * bad) credential can never become the confirmed one.
 */
export async function confirmWriteGrant(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
  grantId: string,
  credential: { user: string; password: string },
): Promise<WriteGrant> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const manifest = getConnectorManifest(connection.connectorId);
  if (!manifest) throw new AppError(500, "UNKNOWN_CONNECTOR", `No manifest for connector "${connection.connectorId}".`);

  const secretStore = getSecretStore(supabase);
  const vaultRef = await secretStore.put(credential, toSecretScope(scope));

  const { data: existingGrants } = await supabase
    .from("write_grants")
    .select("cred_version")
    .eq("connection_id", connectionId);
  const predictedCredVersion =
    (existingGrants ?? []).reduce((max, row) => Math.max(max, (row as { cred_version: number }).cred_version), 0) + 1;

  const testResult = await dispatchTest(
    manifest,
    { connectionId, credVersion: predictedCredVersion, vaultRef },
    connection.config,
  );
  await dispatchInvalidate(manifest, connectionId);
  if (!testResult.ok) {
    await secretStore.delete(vaultRef);
    throw new AppError(
      422,
      "WRITE_GRANT_TEST_FAILED",
      testResult.error?.message ?? "The write credential could not connect.",
      testResult.error?.details,
    );
  }

  const { data, error } = await supabase.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: vaultRef,
    p_write_role_name: credential.user,
  });
  if (error) throw new AppError(409, "CONFIRM_FAILED", error.message);
  return toWriteGrant(data as WriteGrantRow);
}

/** Revocation is a soft-delete (revoked_at set) — see 0007_connectors.sql's header comment. */
export async function revokeWriteGrant(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
  grantId: string,
): Promise<WriteGrant> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const { data, error } = await supabase.rpc("revoke_write_grant", { p_grant_id: grantId });
  if (error) throw new AppError(409, "REVOKE_FAILED", error.message);
  return toWriteGrant(data as WriteGrantRow);
}
