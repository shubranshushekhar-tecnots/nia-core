import { createHmac } from "node:crypto";

/**
 * Stage 5 production-readiness pass — signs ReadContext (packages/schemas/
 * src/contract.ts) for the read-only connector routes this service
 * dispatches to directly: /test, /introspect, /invalidate
 * (connectorDispatch.ts). The analogous /execute and /preflight calls only
 * ever happen from apps/worker, which has its own copy of this same
 * sign/verify pair in apps/worker/src/lib/writeSignature.ts — see that
 * file's header comment for why this is deliberately duplicated per
 * service rather than imported from @nia/schemas (that package is also
 * pulled into apps/web's client bundle, so importing node:crypto there
 * risks breaking the browser build).
 *
 * This service only ever signs, never verifies (apps/api is a caller of
 * the connector services, never a callee of this scheme) — so unlike the
 * worker/connector copies, this file has no verifyReadContext.
 *
 * `route` is never a client-supplied field: each connector route handler
 * hardcodes the literal route name it verifies against, so a signature
 * captured for one route can't be replayed against another. `queryPayload`
 * only applies to /execute (worker-only, not dispatched from here) — always
 * null for the three routes this file signs for, since none of them has any
 * other variable request content worth binding beyond connectionId.
 */

export type ReadSignaturePayload = {
  route: "test" | "introspect" | "execute" | "invalidate" | "preflight";
  connectionId: string;
  queryPayload: string | null;
  issuedAt: number;
};

function canonicalReadPayload(input: ReadSignaturePayload): string {
  return JSON.stringify({
    route: input.route,
    connectionId: input.connectionId,
    queryPayload: input.queryPayload,
    issuedAt: input.issuedAt,
  });
}

export function signReadContext(input: ReadSignaturePayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalReadPayload(input)).digest("hex");
}
