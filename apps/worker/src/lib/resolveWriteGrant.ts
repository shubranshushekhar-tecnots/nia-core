import { withServiceRole } from "@nia/db";
import { dbPool } from "./dbPool.js";
import type { DispatchResult } from "./errors.js";

export type ResolvedWriteGrant = {
  grantId: string;
  credVersion: number;
  vaultRef: string;
};

type WriteGrantRow = {
  id: string;
  cred_version: number;
  write_credential_vault_ref: string | null;
  scope: Record<string, unknown> | null;
};

/**
 * Finds the connection's confirmed, unrevoked write grant whose scope
 * covers `namespace` — the worker-side pre-dispatch half of Block 2's "two
 * layers even inside the internal network" guardrail. connector-supabase's
 * pool-manager.ts (verifyActiveWriteGrant) independently re-derives the
 * same check by grantId once the signed WriteContext reaches it, so a grant
 * revoked between this call and that one is still caught.
 *
 * A connection can accumulate multiple grant rows over its history
 * (rotation is revoke + re-create, never re-confirm — see 0016's header
 * comment); ordering by granted_at desc and taking the first scope match
 * means dispatch always uses the current credential, never a stale
 * already-revoked one lingering earlier in the table.
 */
export async function resolveWriteGrant(connectionId: string, namespace: string): Promise<DispatchResult<ResolvedWriteGrant>> {
  const result = await withServiceRole(dbPool, (db) =>
    db.query<WriteGrantRow>(
      `select id, cred_version, write_credential_vault_ref, scope
       from public.write_grants
       where connection_id = $1 and confirmed_at is not null and revoked_at is null
       order by granted_at desc`,
      [connectionId],
    ),
  );

  const rows = result.rows;
  const match = rows.find((row) => {
    const schemas = (row.scope as { schemas?: unknown } | null)?.schemas;
    return Array.isArray(schemas) && schemas.includes(namespace);
  });

  if (!match || !match.write_credential_vault_ref) {
    return {
      ok: false,
      error: {
        kind: "grant-invalid",
        message: `No confirmed, unrevoked write grant covers schema "${namespace}" on connection ${connectionId}.`,
      },
    };
  }

  return {
    ok: true,
    value: { grantId: match.id, credVersion: match.cred_version, vaultRef: match.write_credential_vault_ref },
  };
}
