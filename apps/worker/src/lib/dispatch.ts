import { validateBeforeDispatch, type ConnectionScope } from "@nia/guardrails";
import type { QueryPayload, TabularResult } from "@nia/schemas";
import { resolveConnection, type ResolvedConnection } from "./resolveConnection.js";
import { sendToConnector } from "./connectorClient.js";
import { logExecutionAudit } from "./executionAudit.js";
import type { WorkspaceScope } from "./workspaceScope.js";
import type { DispatchResult } from "./errors.js";

export type DispatchOpts = {
  rowCap?: number;
  timeoutMs?: number;
  /** Passed through to @nia/guardrails as ConnectionScope.allowedTargets. */
  allowedTargets?: string[];
};

/**
 * The one dispatch entry point every job handler (index.ts) is required to
 * call to run a query against a connection. Orchestrates, in order:
 *   1. resolveConnection — mandatory WorkspaceScope, RLS-equivalent check
 *      re-derived in application code (see resolveConnection.ts).
 *   2. validateBeforeDispatch (@nia/guardrails) — the only function able to
 *      mint a ValidatedQuery.
 *   3. sendToConnector — typed to accept ONLY a ValidatedQuery; no other
 *      function in this worker is allowed to call it directly.
 *   4. logExecutionAudit — on every path that reaches a resolved connection,
 *      success or failure alike.
 *
 * NOTE on why this function still takes a raw QueryPayload even though the
 * whole point of ValidatedQuery is that guardrails must be structurally
 * unskippable: this is the one place in the worker that legitimately has to
 * accept an unvalidated query, because it doesn't know which manifestId to
 * validate against until AFTER resolveConnection runs. The structural
 * guarantee lives one level down, at sendToConnector's type boundary — see
 * connectorClient.ts's header comment and connectorClient.test.ts's
 * compile-error proof.
 */
export async function dispatch(
  connectionId: string,
  query: QueryPayload,
  scope: WorkspaceScope,
  actorUserId: string,
  opts: DispatchOpts = {},
): Promise<DispatchResult<TabularResult>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const connectionScope: ConnectionScope = {
    connectionId: connection.id,
    allowedTargets: opts.allowedTargets,
  };
  const validation = validateBeforeDispatch(connection.connectorId, query, connectionScope);
  if (!validation.ok) {
    await auditDispatch(connection, actorUserId, describeQuery(query));
    return { ok: false, error: { kind: "guardrail-rejected", message: validation.reason } };
  }
  const validated = validation.sanitizedQuery;

  // Defense in depth: validateBeforeDispatch was already called with
  // connection.connectorId above, so this can only fail if @nia/guardrails'
  // internal registry wiring is broken — but per the approved plan, dispatch
  // is the required place to assert it, not just trust it, since a
  // ValidatedQuery carries the manifestId it was validated against
  // specifically so this check is possible.
  if (validated.manifestId !== connection.connectorId) {
    await auditDispatch(connection, actorUserId, describeQuery(query));
    return {
      ok: false,
      error: {
        kind: "service-error",
        message: `Validated query was validated for connector "${validated.manifestId}" but the resolved connection is "${connection.connectorId}".`,
      },
    };
  }

  const result = await sendToConnector(connection.manifest, connection.credential, connection.config, validated, {
    rowCap: opts.rowCap,
    timeoutMs: opts.timeoutMs,
  });

  await auditDispatch(connection, actorUserId, result.ok ? result.value.meta.executedQuery : describeQuery(query));

  return result;
}

function describeQuery(query: QueryPayload): string {
  return query.kind === "sql" ? query.sql : JSON.stringify({ collection: query.collection, pipeline: query.pipeline });
}

async function auditDispatch(connection: ResolvedConnection, actorUserId: string, queryText: string): Promise<void> {
  await logExecutionAudit({
    connectionId: connection.id,
    connectionOwnerUserId: connection.ownerUserId,
    connectorId: connection.connectorId,
    handle: connection.handle,
    operation: "execute",
    query: queryText,
    actorUserId,
  });
}
