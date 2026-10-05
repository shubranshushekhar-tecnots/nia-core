import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Clone of services/connector-mysql/src/writeSignature.ts's ReadContext
 * half only — the bridge's internal listener (/test, /introspect,
 * /execute) is signed exactly like every other connector service's read
 * routes (point 3 of the approved plan: never trust ids in the request
 * body, always verify the signed context first). Deliberately duplicated
 * per-service rather than imported from a shared package, same reason as
 * the original: @nia/schemas is also bundled into apps/web's browser
 * build, and node:crypto would break that.
 */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type ReadSignaturePayload = {
  route: "test" | "introspect" | "execute" | "invalidate" | "preflight";
  connectionId: string;
  queryPayload: string | null;
  issuedAt: number;
};

const WRITE_CONTEXT_MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

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
