import { createHash } from "node:crypto";
import { canonicalizeContractForHash, type DestinationContract } from "@nia/schemas";

/**
 * Schema layer, Part 4 — hashes a built DestinationContract. Same split as
 * apps/worker/src/lib/clean/cleanPlan.ts's computeStepsHash: the
 * canonicalization (strip non-semantic fields, sort columns) lives in
 * packages/schemas/src/destinationContract.ts's canonicalizeContractForHash
 * (browser-bundle-safe, no node:crypto); this file only owns the actual
 * `createHash("sha256")` call. Used by runEtl.ts's ensureDestination() to
 * compare a freshly-built contract's hash against an already-set
 * SourceDestConfig.contractHash for drift (read-only — see
 * destinationContract.ts's header comment on why writing an approved hash
 * back onto the node config is out of Part 4's scope).
 */
export function computeContractHash(contract: DestinationContract): string {
  const json = JSON.stringify(canonicalizeContractForHash(contract));
  return createHash("sha256").update(json).digest("hex");
}
