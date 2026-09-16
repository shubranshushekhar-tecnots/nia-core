import { dispatch } from "../../dispatch.js";
import { invalidateSchema } from "../../introspection.js";
import { publishChatEvent } from "../publish.js";
import type { DispatchState } from "./shared.js";

/**
 * Calls the existing, required dispatch() chokepoint directly — resolve +
 * guardrail + execute + audit — rather than decomposing it, per its own
 * header comment ("The one dispatch entry point every job handler is
 * required to call"). resolveConnectionNode ran earlier only to fetch the
 * manifest/config needed for schema + query generation; this is the real,
 * audited execution.
 *
 * Classifies the DispatchResult into one of three routes for graph.ts's
 * conditional edge:
 *  - "ok": tabularResult is set, proceed to answer generation.
 *  - "guardrail-rejected": the generated query was unsafe. Retried once
 *    (graph.ts checks queryGenAttempts) by regenerating against the SAME
 *    schema with the rejection reason fed back — this is a safety retry,
 *    not a staleness one.
 *  - "retryable": a non-guardrail dispatch failure (service-error /
 *    query-timeout / service-unreachable) against a CACHED schema. Could be
 *    schema drift (see introspection.ts's header comment on TTL vs drift)
 *    — invalidated and re-introspected once (graph.ts checks
 *    reintrospectedAfterFailure) before giving up.
 *  - "terminal": connection-not-found, or any failure that's already been
 *    retried once — fails cleanly.
 *
 * Widened to DispatchState (see shared.ts) so this same function is reused
 * unchanged by the multi-source per-source subgraph.
 */
export async function dispatchNode(state: DispatchState): Promise<Partial<DispatchState>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "executing" });
  const connection = state.connection!;
  const queryPayload = state.queryPayload!;

  const result = await dispatch(state.connectionId, queryPayload, state.scope, state.userId);

  if (result.ok) {
    return { tabularResult: result.value, lastDispatchOutcome: "ok", error: undefined };
  }

  if (result.error.kind === "guardrail-rejected") {
    if (state.queryGenAttempts >= 1) {
      return { lastDispatchOutcome: "terminal", error: `Guardrail rejected the query twice: ${result.error.message}` };
    }
    return {
      lastDispatchOutcome: "guardrail-rejected",
      guardrailRejectionReason: result.error.message,
      queryGenAttempts: state.queryGenAttempts + 1,
    };
  }

  if (result.error.kind === "connection-not-found") {
    return { lastDispatchOutcome: "terminal", error: result.error.message };
  }

  // service-error / service-unreachable / query-timeout against a schema
  // that may now be stale.
  if (!state.reintrospectedAfterFailure) {
    invalidateSchema(connection);
    return { lastDispatchOutcome: "retryable", reintrospectedAfterFailure: true };
  }
  return { lastDispatchOutcome: "terminal", error: result.error.message };
}
