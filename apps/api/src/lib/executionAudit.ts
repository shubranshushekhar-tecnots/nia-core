import type { SupabaseClient } from "@supabase/supabase-js";
import { ExecutionAuditInput, type ExecutionAuditInput as ExecutionAuditInputType } from "@nia/schemas";

/**
 * The one and only execution-audit call site for apps/api. Every route that
 * dispatches a real query against a connection (connections.test today;
 * introspect/execute later) must call this — never insert into audit_log
 * ad hoc. Backed by 0009_connector_write_paths.sql's log_execution_audit
 * RPC, which is the only insert path that exists for this table from
 * application code.
 *
 * `supabase` must be the caller's own per-request client (req.supabase) —
 * the RPC derives the actor from auth.uid() for authenticated callers, so
 * passing a different client would misattribute the execution.
 */
export async function logExecutionAudit(
  supabase: SupabaseClient,
  input: ExecutionAuditInputType,
): Promise<void> {
  const parsed = ExecutionAuditInput.parse(input);
  const { error } = await supabase.rpc("log_execution_audit", {
    p_connection_id: parsed.connectionId,
    p_connection_owner_user_id: parsed.connectionOwnerUserId,
    p_connector_id: parsed.connectorId,
    p_handle: parsed.handle,
    p_operation: parsed.operation,
    p_query: parsed.query,
  });
  if (error) {
    throw new Error(`execution audit failed: ${error.message}`);
  }
}
