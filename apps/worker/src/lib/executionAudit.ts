import { ExecutionAuditInput, type ExecutionAuditInput as ExecutionAuditInputType } from "@nia/schemas";
import { supabase } from "./supabaseClient.js";

/**
 * Worker-side mirror of apps/api/src/lib/executionAudit.ts, calling the same
 * log_execution_audit RPC (0009_connector_write_paths.sql) — but through
 * this module's service_role client (supabaseClient.ts). The RPC treats
 * service_role callers as a distinct branch and REQUIRES p_actor_user_id
 * explicitly (there is no auth.uid() to fall back on for a client with no
 * live user JWT), which is why `actorUserId` is a required field on
 * ExecutionAuditInput, not inferred here.
 *
 * dispatch.ts calls this on every dispatch that reaches a resolved
 * connection — success and failure alike (guardrail-rejected,
 * service-unreachable, service-error, query-timeout). The one dispatch
 * failure this can never cover is connection-not-found: the RPC looks up
 * org_id/owner_id from the connections row itself and raises if it can't
 * find one, so there is no connection, and no workspace, to attribute that
 * audit row to in the first place.
 */
export async function logExecutionAudit(input: ExecutionAuditInputType): Promise<void> {
  const parsed = ExecutionAuditInput.parse(input);
  const { error } = await supabase.rpc("log_execution_audit", {
    p_connection_id: parsed.connectionId,
    p_connection_owner_user_id: parsed.connectionOwnerUserId,
    p_connector_id: parsed.connectorId,
    p_handle: parsed.handle,
    p_operation: parsed.operation,
    p_query: parsed.query,
    p_actor_user_id: parsed.actorUserId,
  });
  if (error) {
    throw new Error(`execution audit failed: ${error.message}`);
  }
}
