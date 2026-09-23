/**
 * The normalized dispatch failure shape. Every way a dispatch() call can
 * fail collapses into exactly one of these five kinds — no other error
 * shape is allowed to escape dispatch.ts. Row-cap truncation is
 * deliberately NOT one of these: rows came back, so it's a success with
 * `TabularResult.meta.truncated = true`, not a failure (see dispatch.ts's
 * header comment). Distinguishing "all rows" from "truncated" for callers
 * that build on the result (e.g. the future chat pipeline) is an open TODO,
 * intentionally not solved here.
 *
 *  - connection-not-found: the id doesn't exist, OR it exists but belongs
 *    to a different org/owner than the caller's WorkspaceScope. These two
 *    cases are indistinguishable on purpose — see resolveConnection.ts.
 *  - guardrail-rejected: validateBeforeDispatch (@nia/guardrails) refused
 *    the query.
 *  - service-unreachable: the connector service's /execute endpoint could
 *    not be reached at all (network/connection error).
 *  - service-error: the connector service responded, but with a non-2xx
 *    status or a response that doesn't match ExecuteResponse.
 *  - query-timeout: the request to the connector service was aborted after
 *    exceeding its timeout budget.
 *  - grant-invalid: Phase 6 Block 2's write-dispatch pre-check
 *    (resolveWriteGrant.ts) — the connection has no confirmed, unrevoked
 *    write grant covering the entity's namespace. The connector service
 *    re-derives this same check independently (pool-manager.ts's
 *    verifyActiveWriteGrant) — this is the worker-side half of the spec's
 *    "two layers even inside the internal network" guardrail, so a grant
 *    revoked between the worker's check and the connector's own re-check
 *    is still caught.
 */
export type DispatchErrorKind =
  | "connection-not-found"
  | "guardrail-rejected"
  | "service-unreachable"
  | "service-error"
  | "query-timeout"
  | "grant-invalid";

export type DispatchError = {
  kind: DispatchErrorKind;
  message: string;
};

/** Generic ok/error result — dispatch.ts and every module it composes return this, never throw. */
export type DispatchResult<T> = { ok: true; value: T } | { ok: false; error: DispatchError };
