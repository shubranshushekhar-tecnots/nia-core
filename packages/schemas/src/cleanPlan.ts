import { z } from "zod";
import type { TransformStep } from "./nodeConfig.js";

/**
 * Phase 13, Step 6 — CleanPlan: the binding recorded when a specialist-
 * authored cleaning PlanDiff (assemble.ts's buildAssembledPlan) is applied
 * to a workflow node. Distinct from copilot_applied_plans (which records
 * WHAT was applied and enables revert) — a CleanPlan additionally records
 * the exact upstream conditions the proposal was computed against (schema
 * shape, profile shape, op semantics), so a later run can detect drift and
 * refuse rather than silently re-executing steps that were proposed
 * against a source that has since changed shape. See runEtl.ts's drift
 * check (apps/worker/src/lib/etl/cleanPlanDrift.ts) for the read side and
 * copilotDiffApply.ts's applyCleaningPlanDiff for the write side.
 *
 * `opCatalogVersion`/`adapterVersion` are bumped whenever the closed Expr
 * op vocabulary (expression.ts) or a connector adapter's semantics change
 * in a way that could make a previously-compiled step behave differently
 * — a CleanPlan bound to an older version is treated as drifted even if
 * the schema/profile hashes still match, per the plan's Step 6 text.
 * Bump these by hand when such a change ships; there's no automation for
 * detecting "semantics changed," same as any other manually-tracked
 * schema-version constant in this codebase.
 */
export const OP_CATALOG_VERSION = 1;
export const ADAPTER_VERSION = 1;

export const CleanPlanRecord = z.object({
  id: z.string(),
  workflowId: z.string(),
  nodeId: z.string(),
  appliedPlanId: z.string(),
  /** Hash of the node's specialist-authored steps' functional definition (excludes id/provenance — see cleanPlan.ts's computeStepsHash in apps/worker). */
  stepsHash: z.string(),
  /** Hash of the source entity's column name+declaredType shape at propose time — coarser than profileHash, catches column add/remove/retype. */
  sourceSchemaHash: z.string(),
  /** The EntityProfile.profileHash the specialists' proposals were computed against (profile.ts) — catches shape drift within an unchanged column set (e.g. a column that stops having nulls). */
  profileHash: z.string(),
  opCatalogVersion: z.number(),
  adapterVersion: z.number(),
  appliedAt: z.string(),
});
export type CleanPlanRecord = z.infer<typeof CleanPlanRecord>;

/** One binding's drift-check outcome — used by both the run-start refusal (runEtl.ts) and its unit test. */
export type CleanPlanDriftResult =
  | { ok: true }
  | { ok: false; nodeId: string; reason: "schema-changed" | "profile-changed" | "catalog-version-changed" | "adapter-version-changed"; message: string };

/**
 * Shared, crypto-free canonicalization for stepsHash — lives here (not
 * apps/worker) so both apps/worker (propose-time compute, run-start drift
 * recompute) and apps/api (apply-time compute, manual-edit-unbind compute
 * in putWorkflowGraph) hash the EXACT same canonical shape via their own
 * thin `createHash("sha256")` wrapper. Keeping only the hash call itself
 * (not this canonicalization) duplicated between those two runtimes is a
 * deliberate, minimal risk: this file is imported by apps/web's browser
 * bundle too, so it can never import `node:crypto` directly (see
 * apps/worker/src/lib/profile/signature.ts's header comment for the same
 * constraint on profileHash/schemaHash, which stay apps/worker-only since
 * only apps/worker ever computes those).
 */
function sortKeysForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForHash);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysForHash(v)]));
  }
  return value;
}

/** Strips `id`/`provenance` (identity, not behavior) and, for `aggregate` steps, `observedCount`/`probedAt` (Copilot's cardinality-probe evidence) — see apps/worker/src/lib/clean/cleanPlan.ts's header comment for the full rationale. */
function canonicalizeStepForHash(step: TransformStep): unknown {
  const { id: _id, provenance: _provenance, ...rest } = step as TransformStep & { id?: string; provenance?: unknown };
  if (rest.kind === "aggregate") {
    const { observedCount: _observedCount, probedAt: _probedAt, ...aggregateRest } = rest;
    return sortKeysForHash(aggregateRest);
  }
  return sortKeysForHash(rest);
}

/** The exact canonical (pre-hash) shape for a node's steps array — pass `JSON.stringify(canonicalizeStepsForHash(steps))` into a sha256 wrapper. */
export function canonicalizeStepsForHash(steps: TransformStep[]): unknown {
  return steps.map(canonicalizeStepForHash);
}

/** The exact canonical (pre-hash) shape for a source entity's column name+declaredType set — see apps/worker/src/lib/profile/signature.ts's computeSchemaHash. */
export function canonicalizeSchemaColumnsForHash(columns: { name: string; declaredType: string }[]): unknown {
  return columns.map((c) => ({ name: c.name, declaredType: c.declaredType })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the "Propose cleaning" flow's caller (apps/api's applyPlanDiff, via
 * a new optional field on its own input) must carry through from the
 * worker's propose-time result to apply time, since only the worker ever
 * profiles a source (apps/api never dispatches a connector read directly).
 * stepsHash is deliberately NOT part of this — apps/api recomputes it
 * itself from the diff's final applied ops, so a ghost-preview edit before
 * apply is still hashed correctly rather than trusting a stale propose-time
 * value.
 */
export const CleanBindingInput = z.object({
  sourceSchemaHash: z.string(),
  profileHash: z.string(),
});
export type CleanBindingInput = z.infer<typeof CleanBindingInput>;
