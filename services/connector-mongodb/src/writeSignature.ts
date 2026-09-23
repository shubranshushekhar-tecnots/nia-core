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
