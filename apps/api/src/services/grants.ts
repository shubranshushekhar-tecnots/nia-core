import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
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
};

const GRANTS_SELECT =
  "id, connection_id, granted_by_user_id, scope, granted_at, revoked_at, confirmed_at, cred_version, write_credential_vault_ref";

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
 * Second step: attaches the write credential's Vault ref. Fails (RPC
 * raises) if the grant is already confirmed or already revoked — 0016's
 * deliberate non-idempotence; rotation is revoke + create a new grant, not
 * re-confirm.
 */
export async function confirmWriteGrant(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
  grantId: string,
  writeCredentialVaultRef: string,
): Promise<WriteGrant> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const { data, error } = await supabase.rpc("confirm_write_grant", {
    p_grant_id: grantId,
    p_write_credential_vault_ref: writeCredentialVaultRef,
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
