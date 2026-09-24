import type { WriteContext, WriteEntityRef, WriteRequest, WriteResponse } from "@nia/schemas";
import { resolveConnection, type ResolvedConnection } from "./resolveConnection.js";
import { resolveWriteGrant } from "./resolveWriteGrant.js";
import { sendWriteRequest } from "./connectorClient.js";
import { signWriteContext } from "./writeSignature.js";
import { logExecutionAudit } from "./executionAudit.js";
import { env } from "../env.js";
import type { WorkspaceScope } from "@nia/db";
import type { DispatchResult } from "./errors.js";

export type WriteDispatchInput = {
  entity: WriteEntityRef;
  columns: string[];
  rows: unknown[][];
  upsertKeys: string[];
  timeoutMs?: number;
  /**
   * Phase 11: set by the ETL runner when a chunk is being upserted into a
   * run's staging table (or its quarantine sink) instead of the
   * destination directly — see stagedWriteDispatch.ts. Left undefined for
   * today's direct-mode writes, which sign/send a plain row-upsert context
   * (runId/stagingEntity/quarantineEntity null, mode "upsert").
   */
  runId?: string | null;
  mode?: WriteContext["mode"];
  stagingEntity?: WriteEntityRef | null;
  quarantineEntity?: WriteEntityRef | null;
  /**
   * The namespace whose confirmed write grant authorizes this write — see
   * contract.ts's WriteContext doc comment. Defaults to `entity.namespace`
   * (today's only behavior before this field existed). Callers writing
   * into a staging/quarantine entity in Nia's internal "nia" schema (see
   * stagedWrite.ts) must set this explicitly to the run's real destination
   * namespace: "nia" writes are authorized by that run's own destination
   * grant, and nothing wider.
   */
  grantNamespace?: string;
};

/**
 * The write counterpart to dispatch.ts. Orchestrates, in order:
 *   1. resolveConnection — same mandatory WorkspaceScope re-derivation as
 *      the read path.
 *   2. resolveWriteGrant — the worker-side half of Block 2's "two layers
 *      even inside the internal network" guardrail; connector-supabase's
 *      pool-manager.ts independently re-derives the same confirmed/
 *      unrevoked/scope-covers-namespace check once the signed context
 *      reaches it, so a grant revoked between these two checks is still
 *      caught there.
 *   3. signWriteContext — mints the HMAC-signed WriteContext the connector
 *      service verifies before touching its write pool at all.
 *   4. sendWriteRequest — the HTTP hop to the connector's /write endpoint.
 *   5. logExecutionAudit — on every path that reaches a resolved
 *      connection, success or failure alike, same as dispatch.ts.
 *
 * Unlike dispatch.ts, there is no @nia/guardrails validateBeforeDispatch
 * step: a write request is structured (entity/columns/rows), not raw SQL
 * text, so there is nothing for validateReadOnlySql's allowlist to parse —
 * see contract.ts's WriteRequest header comment for why this is a
 * deliberate design split, not a gap.
 */
export async function dispatchWrite(
  connectionId: string,
  input: WriteDispatchInput,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<WriteResponse>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const grantNamespace = input.grantNamespace ?? input.entity.namespace;
  const grant = await resolveWriteGrant(connection.id, grantNamespace);
  if (!grant.ok) {
    await auditWrite(connection, actorUserId, input, `rejected: ${grant.error.message}`);
    return grant;
  }

  const issuedAt = Date.now();
  const runId = input.runId ?? null;
  const mode = input.mode ?? "upsert";
  const stagingEntity = input.stagingEntity ?? null;
  const quarantineEntity = input.quarantineEntity ?? null;
  const signature = signWriteContext(
    {
      connectionId: connection.id,
      grantId: grant.value.grantId,
      runId,
      entity: input.entity,
      grantNamespace,
      columns: input.columns,
      mode,
      stagingEntity,
      quarantineEntity,
      issuedAt,
    },
    env.WRITE_DISPATCH_SIGNING_SECRET,
  );
  const context: WriteContext = {
    connectionId: connection.id,
    grantId: grant.value.grantId,
    runId,
    entity: input.entity,
    grantNamespace,
    columns: input.columns,
    mode,
    stagingEntity,
    quarantineEntity,
    issuedAt,
    signature,
  };

  const request: WriteRequest = {
    credential: { connectionId: connection.id, credVersion: grant.value.credVersion, vaultRef: grant.value.vaultRef },
    config: connection.config,
    entity: input.entity,
    columns: input.columns,
    rows: input.rows,
    upsertKeys: input.upsertKeys,
    timeoutMs: input.timeoutMs ?? 15000,
    context,
  };

  const result = await sendWriteRequest(connection.manifest, request, { timeoutMs: input.timeoutMs });
  await auditWrite(connection, actorUserId, input, result.ok ? `wrote ${result.value.written} row(s)` : result.error.message);
  return result;
}

async function auditWrite(
  connection: ResolvedConnection,
  actorUserId: string,
  input: WriteDispatchInput,
  outcome: string,
): Promise<void> {
  await logExecutionAudit({
    connectionId: connection.id,
    connectionOwnerUserId: connection.ownerUserId,
    connectorId: connection.connectorId,
    handle: connection.handle,
    operation: "write",
    query: `UPSERT ${input.entity.namespace}.${input.entity.name} (${input.columns.join(", ")}) x${input.rows.length} row(s) -> ${outcome}`,
    actorUserId,
  });
}
