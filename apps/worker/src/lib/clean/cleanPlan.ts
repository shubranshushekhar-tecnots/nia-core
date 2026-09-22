import { createHash } from "node:crypto";
import { canonicalizeStepsForHash, type TransformStep } from "@nia/schemas";

/**
 * Phase 13, Step 6 — hashes a node's TransformConfig.steps' FUNCTIONAL
 * definition: what each step actually does, not its identity or how it
 * got there. The canonicalization itself (strip id/provenance/aggregate's
 * observedCount+probedAt, sort keys) lives in
 * packages/schemas/src/cleanPlan.ts's canonicalizeStepsForHash — shared
 * with apps/api's own copy of this same `createHash("sha256")` wrapper
 * (copilotDiffApply.ts computes stepsHash at apply time and putWorkflowGraph
 * recomputes it to detect a manual-edit unbind) — so this file only ever
 * owns the `node:crypto` call, which packages/schemas can't import directly
 * (browser-bundle constraint, see that file's header comment).
 */
export function computeStepsHash(steps: TransformStep[]): string {
  const json = JSON.stringify(canonicalizeStepsForHash(steps));
  return createHash("sha256").update(json).digest("hex");
}
