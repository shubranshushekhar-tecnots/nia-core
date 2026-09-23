import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 6 Block 2 — signs/verifies the write-dispatch context. This exact
 * file is duplicated (not imported) in services/connector-supabase/src/
 * writeSignature.ts: the worker signs, connector-supabase independently
 * recomputes + verifies, and neither should trust a shared @nia/schemas
 * import for this since that package is also pulled into apps/web's
 * client bundle (see package.json) — importing node:crypto there risks
 * breaking the browser build. Small and Node-only, so duplication (same
 * precedent as apps/worker/src/lib/workspaceScope.ts's own local
 * WorkspaceScope copy) beats a new shared-package dependency for two
 * server-only processes.
 *
 * Signature is over a canonical JSON string (sorted columns, fixed key
 * order) of everything the signed context asserts — connectionId, grantId,
 * entity, columns, issuedAt — so any tampering with any of those fields
 * after signing invalidates it. `MAX_AGE_MS` bounds replay even though
 * this only ever crosses the internal Docker network.
 *
 * Phase 11: `runId`/`mode`/`stagingEntity`/`quarantineEntity` joined the
 * signed payload so a /stage request's staging lifecycle is bound to the
 * exact same signature as a row-write request — see contract.ts's
 * WriteContext doc comment. `stagingEntity`/`quarantineEntity` are
 * destructured to their two string fields (not nested) in the canonical
 * payload so `null` vs `{namespace,name}` can't collide with any other
 * field's JSON shape.
 */

export const WRITE_CONTEXT_MAX_AGE_MS = 60_000;
/** Small forward allowance for clock skew between the worker and connector-supabase hosts. */
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
