import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 6 Block 5 — signs/verifies the write-dispatch context. Byte-for-byte
 * duplicate of connector-supabase/src/writeSignature.ts — see that file's
 * header comment for why this is deliberately copied rather than imported
 * from a shared package (the worker signs, each connector independently
 * recomputes + verifies; @nia/schemas is also pulled into apps/web's
 * client bundle, so importing node:crypto there risks breaking the browser
 * build).
 */

export const WRITE_CONTEXT_MAX_AGE_MS = 60_000;
/** Small forward allowance for clock skew between the worker and this connector's host. */
const CLOCK_SKEW_MS = 5_000;

/**
 * Thrown for a specific HTTP status instead of a bare Error (which Fastify
 * defaults to 500). Fastify's default error handler uses `error.statusCode`
 * when present, so this alone is enough — no custom setErrorHandler needed.
 */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type WriteSignaturePayload = {
  connectionId: string;
  grantId: string;
  runId: string | null;
  entity: { namespace: string; name: string };
  /** The namespace whose write grant authorizes this write — see contract.ts's WriteContext doc comment. Signed so a connector's re-check can't be fooled by an unsigned field. */
  grantNamespace: string;
  columns: string[];
  mode: string;
  stagingEntity: { namespace: string; name: string } | null;
  quarantineEntity: { namespace: string; name: string } | null;
  issuedAt: number;
};

function canonicalPayload(input: WriteSignaturePayload): string {
  return JSON.stringify({
    connectionId: input.connectionId,
    grantId: input.grantId,
    runId: input.runId,
    namespace: input.entity.namespace,
    name: input.entity.name,
    grantNamespace: input.grantNamespace,
    columns: [...input.columns].sort(),
    mode: input.mode,
    stagingNamespace: input.stagingEntity?.namespace ?? null,
    stagingName: input.stagingEntity?.name ?? null,
    quarantineNamespace: input.quarantineEntity?.namespace ?? null,
    quarantineName: input.quarantineEntity?.name ?? null,
    issuedAt: input.issuedAt,
  });
}

export function signWriteContext(input: WriteSignaturePayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalPayload(input)).digest("hex");
}

export function verifyWriteContext(input: WriteSignaturePayload, signature: string, secret: string): boolean {
  const expected = signWriteContext(input, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return false;
  }
  const now = Date.now();
  return input.issuedAt <= now + CLOCK_SKEW_MS && now - input.issuedAt <= WRITE_CONTEXT_MAX_AGE_MS;
}

/**
 * Stage 5 production-readiness pass — signs/verifies ReadContext
 * (contract.ts), the lighter read-path counterpart to WriteSignaturePayload
 * above, covering /test, /introspect, /execute, /invalidate, /preflight.
 * `route` is never a client-supplied field: each connector route handler
 * hardcodes the literal route name it verifies against, so a signature
 * captured for one route can't be replayed against another. `queryPayload`
 * is the JSON.stringify'd QueryPayload for /execute only — binds the exact
 * query text/pipeline to the signature so a captured signature can't be
 * replayed with a different query against the same connection — and null
 * for every other route, which has no other variable request content worth
 * binding beyond connectionId. Reuses WRITE_CONTEXT_MAX_AGE_MS/CLOCK_SKEW_MS
 * above rather than defining separate constants for a distinction with no
 * operational difference.
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

export function verifyReadContext(input: ReadSignaturePayload, signature: string, secret: string): boolean {
  const expected = signReadContext(input, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return false;
  }
  const now = Date.now();
  return input.issuedAt <= now + CLOCK_SKEW_MS && now - input.issuedAt <= WRITE_CONTEXT_MAX_AGE_MS;
}
