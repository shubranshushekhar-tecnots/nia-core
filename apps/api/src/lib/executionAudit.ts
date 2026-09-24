import { ExecutionAuditInput, type ExecutionAuditInput as ExecutionAuditInputType } from "@nia/schemas";
import type { WithUser } from "./withUser.js";

/**
 * The one and only execution-audit call site for apps/api. Every route that
 * dispatches a real query against a connection (connections.test today;
 * introspect/execute later) must call this — never insert into audit_log
 * ad hoc. Backed by 0009_connector_write_paths.sql's log_execution_audit
 * RPC, which is the only insert path that exists for this table from
 * application code.
 *
 * `withUser` must be the caller's own request-scoped closure (req.withUser)
 * — the function derives the actor from auth.uid() for authenticated
 * callers, so passing a different acting-user context would misattribute
 * the execution.
 */
export async function logExecutionAudit(
  withUser: WithUser,
  input: ExecutionAuditInputType,
): Promise<void> {
  const parsed = ExecutionAuditInput.parse(input);
  await withUser((db) =>
    db.query(
      `select public.log_execution_audit($1, $2, $3, $4, $5, $6)`,
      [parsed.connectionId, parsed.connectionOwnerUserId, parsed.connectorId, parsed.handle, parsed.operation, parsed.query],
    ),
  );
}
