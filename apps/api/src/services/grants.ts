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
};

const GRANTS_SELECT = "id, connection_id, granted_by_user_id, scope, granted_at, revoked_at";

type WriteGrantRow = {
  id: string;
  connection_id: string;
  granted_by_user_id: string;
  scope: Record<string, unknown>;
  granted_at: string;
  revoked_at: string | null;
};

function toWriteGrant(row: WriteGrantRow): WriteGrant {
  return {
    id: row.id,
    connectionId: row.connection_id,
    grantedByUserId: row.granted_by_user_id,
    scope: row.scope,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * write_grants has no org_id/owner_id of its own (0007_connectors.sql) —
 * scope comes entirely from the parent connection, so every entry point
 * here first loads the connection through the caller's own workspace scope
 * (which is itself RLS-backed) to confirm access before touching grants.
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
  grantedByUserId: string,
  grantScope: Record<string, unknown>,
): Promise<WriteGrant> {
  const connection = await getConnection(supabase, scope, connectionId);
  if (!connection) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const { data, error } = await supabase
    .from("write_grants")
    .insert({ connection_id: connectionId, granted_by_user_id: grantedByUserId, scope: grantScope })
    .select(GRANTS_SELECT)
    .single();
  if (error) throw new AppError(500, "CREATE_FAILED", error.message);
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

  const { data, error } = await supabase
    .from("write_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .eq("connection_id", connectionId)
    .select(GRANTS_SELECT)
    .single();
  if (error) throw new AppError(500, "REVOKE_FAILED", error.message);
  return toWriteGrant(data as WriteGrantRow);
}
