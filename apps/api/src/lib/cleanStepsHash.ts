import { createHash } from "node:crypto";
import { canonicalizeStepsForHash, type TransformStep } from "@nia/schemas";

/**
 * Phase 13, Step 6 — apps/api's own thin `node:crypto` wrapper around the
 * shared canonicalizeStepsForHash (packages/schemas/src/cleanPlan.ts).
 * Deliberately a one-line duplicate of apps/worker/src/lib/clean/
 * cleanPlan.ts's computeStepsHash rather than importing across app
 * boundaries (apps/api never depends on apps/worker) — both runtimes hash
 * the exact same canonical shape via the shared canonicalizer, so this
 * duplication carries no drift risk: the only thing that differs between
 * the two copies is which local `node:crypto` import each file already
 * has. Used by copilotDiffApply.ts (creating a CleanPlan record's
 * stepsHash on apply) and workflowGraphs.ts's putWorkflowGraph (detecting
 * a manual edit to a CleanPlan-bound node so its binding can be removed).
 */
export function computeStepsHash(steps: TransformStep[]): string {
  const json = JSON.stringify(canonicalizeStepsForHash(steps));
  return createHash("sha256").update(json).digest("hex");
}
