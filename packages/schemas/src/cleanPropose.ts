import { z } from "zod";
import { OnFailurePolicy } from "./nodeConfig.js";
import { PlanDiff } from "./planDiff.js";
import { CleanBindingInput } from "./cleanPlan.js";

/**
 * Phase 13, Step 7 — the clean_propose BullMQ job's return value shape, a
 * shared contract between apps/worker (produces it, lib/clean/
 * proposeCleaning.ts, composing router.ts's routes with assemble.ts's
 * per-step dry-run reports) and apps/api (validates it after crossing the
 * job.data/job.returnvalue JSON round-trip, lib/cleanQueue.ts) — same
 * reason ProposeMappingOutcome (mappingProposal.ts) is a shared zod schema
 * rather than a plain TS type duplicated on both sides.
 *
 * One `CleanColumnReport` per assembled step (i.e. `assemble.ts`'s
 * StepDryRunReport, both included and dropped), enriched with the routing
 * decision (`route`/`routeReason`, router.ts's ColumnRoute) that isn't
 * itself part of assemble.ts's output — the UI's per-column detail (Step
 * 7: "the route reason, the rationale, onFailure, dry-run before -> after,
 * and failure counts") needs both halves merged into one row per column.
 * `skipped` carries the specialists' own no-change/dropped outcomes
 * (assemble.ts's skippedProposals); `skippedIdentifierLike` is a distinct
 * list of columns the ROUTER itself excluded from coercion for being
 * identifier-like (router.ts's ColumnRoute.reason contains "identifier-
 * like") — these never reach a specialist at all, so they can't appear in
 * `skipped`.
 */
export const CleanColumnReport = z.object({
  column: z.string(),
  specialist: z.enum(["missing-value", "coercion"]),
  route: z.enum(["missing-value", "coercion", "both", "none"]),
  routeReason: z.string(),
  rationale: z.string(),
  onFailure: OnFailurePolicy,
  before: z.array(z.unknown()),
  after: z.array(z.unknown()),
  sampleSize: z.number(),
  failureCount: z.number(),
  failureRate: z.number(),
  maxFailureRate: z.number(),
  included: z.boolean(),
  dropReason: z.string().optional(),
});
export type CleanColumnReport = z.infer<typeof CleanColumnReport>;

export const CleanSkippedProposal = z.object({
  column: z.string(),
  specialist: z.enum(["missing-value", "coercion"]),
  reason: z.string(),
});
export type CleanSkippedProposal = z.infer<typeof CleanSkippedProposal>;

export const CleanSkippedIdentifierColumn = z.object({
  column: z.string(),
  reason: z.string(),
});
export type CleanSkippedIdentifierColumn = z.infer<typeof CleanSkippedIdentifierColumn>;

/**
 * `binding` is the sourceSchemaHash/profileHash pair the FE must carry
 * straight through, unmodified, to the apply call's `cleanBinding` field
 * (see copilotDiffApply.ts's applyPlanDiff) — only the worker ever
 * profiles a source, so apps/api can't recompute these itself the way it
 * recomputes stepsHash from the diff's final applied ops (see
 * cleanPlan.ts's CleanBindingInput doc comment).
 */
export const CleanProposalResult = z.object({
  diff: PlanDiff,
  columns: z.array(CleanColumnReport),
  skipped: z.array(CleanSkippedProposal),
  skippedIdentifierLike: z.array(CleanSkippedIdentifierColumn),
  binding: CleanBindingInput,
});
export type CleanProposalResult = z.infer<typeof CleanProposalResult>;

export const CleanProposeOutcome = z.union([
  z.object({ ok: z.literal(true), value: CleanProposalResult }),
  z.object({ ok: z.literal(false), error: z.object({ kind: z.string(), message: z.string() }) }),
]);
export type CleanProposeOutcome = z.infer<typeof CleanProposeOutcome>;
