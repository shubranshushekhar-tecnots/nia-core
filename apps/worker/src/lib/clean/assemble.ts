import { randomUUID } from "node:crypto";
import {
  applyResidualTransforms,
  updateStepProvenance,
  type AddStepOp,
  type ComputedFieldStep,
  type PlanDiff,
  type TransformStep,
} from "@nia/schemas";
import type { ColumnStepProposal, SpecialistName, SpecialistResult } from "./specialistTypes.js";

/**
 * Phase 13, Step 5 — merges the two specialists' step proposals (missing-
 * value before coercion, per column's original order within each group),
 * dry-runs them incrementally against a fresh in-memory sample using the
 * residual evaluator (packages/schemas/src/residualTransform.ts), and
 * assembles the surviving steps into a PlanDiff with per-step provenance.
 *
 * Deliberately takes an already-fetched sample (`sampleColumns`/
 * `sampleRows`, the same array-of-arrays shape applyResidualTransforms
 * consumes) rather than calling the profiler's sampleEntity() itself —
 * sampleEntity does real connector I/O (dispatch against a live
 * connection), so keeping it out of this module is what keeps
 * buildAssembledPlan a pure, synchronous function this file's own unit
 * tests can exercise with a hand-built sample, no mocked network calls
 * required. The caller (the "Propose cleaning" action, Step 7) is
 * responsible for calling sampleEntity and passing its rows here.
 */

const COERCION_DROP_THRESHOLD = 0.5;
const MIN_MAX_FAILURE_RATE = 0.01;
const MAX_FAILURE_RATE_MULTIPLIER = 2;

export interface StepDryRunReport {
  column: string;
  specialist: SpecialistName;
  rationale: string;
  step: Omit<ComputedFieldStep, "id" | "provenance">;
  /** Sample values for this column before this step ran (i.e. after any earlier included steps, before this one). */
  before: unknown[];
  /** Sample values for this column after this step ran. Equal to `before` when the step was dropped (see `included`). */
  after: unknown[];
  sampleSize: number;
  failureCount: number;
  failureRate: number;
  maxFailureRate: number;
  /** False when this was a coercion proposal dropped for exceeding the 50% dry-run failure-rate guard — excluded from the returned PlanDiff. */
  included: boolean;
  dropReason?: string;
}

export interface DroppedProposalReport {
  column: string;
  specialist: SpecialistName;
  reason: string;
}

export interface AssembleResult {
  diff: PlanDiff;
  stepReports: StepDryRunReport[];
  /** Proposals that never became a step at all — the specialist's own "no-change"/"dropped" outcomes, surfaced here for the UI (Step 7 lists skipped/failed columns alongside the diff). */
  skippedProposals: DroppedProposalReport[];
}

export interface AssembleInput {
  nodeId: string;
  planId: string;
  model?: string;
  baseGraphVersion: number;
  /** Current length of the target node's TransformConfig.steps array — new steps are appended after it, in order. */
  existingStepCount: number;
  sampleColumns: string[];
  sampleRows: unknown[][];
  missingValue: SpecialistResult;
  coercion: SpecialistResult;
}

interface OrderedProposal {
  column: string;
  specialist: SpecialistName;
  proposal: ColumnStepProposal;
}

function orderedStepProposals(missingValue: SpecialistResult, coercion: SpecialistResult): OrderedProposal[] {
  const fromResult = (result: SpecialistResult): OrderedProposal[] =>
    result.proposals
      .filter((p): p is ColumnStepProposal => p.kind === "step")
      .map((proposal) => ({ column: proposal.column, specialist: result.specialist, proposal }));
  // Order: missing-value steps before coercion steps (plan Step 5); within
  // each group, proposals are already in the specialist's input column
  // order (specialistEngine.runSpecialist preserves `columns` order).
  return [...fromResult(missingValue), ...fromResult(coercion)];
}

function skippedFromResult(result: SpecialistResult): DroppedProposalReport[] {
  return result.proposals
    .filter((p) => p.kind === "no-change" || p.kind === "dropped")
    .map((p) => ({ column: p.column, specialist: result.specialist, reason: p.reason }));
}

function columnValues(columns: string[], rows: unknown[][], column: string): unknown[] {
  const idx = columns.indexOf(column);
  if (idx === -1) return [];
  return rows.map((row) => row[idx]);
}

/**
 * Runs one step against the current sample via the residual evaluator and
 * reports its failure count. `columns`/`rows` are NOT mutated — callers
 * decide whether to carry the result forward (step included) or discard it
 * (step dropped for exceeding the failure-rate guard).
 */
function dryRunOneStep(
  columns: string[],
  rows: unknown[][],
  step: TransformStep,
): { columns: string[]; rows: unknown[][]; failureCount: number } {
  const result = applyResidualTransforms(columns, rows, [step]);
  const failureCount = result.failures.reduce((sum, f) => sum + f.count, 0);
  return { columns: result.columns, rows: result.rows, failureCount };
}

export function buildAssembledPlan(input: AssembleInput): AssembleResult {
  const { nodeId, planId, model, baseGraphVersion, existingStepCount, sampleColumns, sampleRows, missingValue, coercion } = input;

  const ordered = orderedStepProposals(missingValue, coercion);
  const skippedProposals = [...skippedFromResult(missingValue), ...skippedFromResult(coercion)];

  let currentColumns = sampleColumns;
  let currentRows = sampleRows;
  const sampleSize = sampleRows.length;

  const stepReports: StepDryRunReport[] = [];
  const ops: AddStepOp[] = [];
  let nextIndex = existingStepCount;

  for (const { column, specialist, proposal } of ordered) {
    const candidateStep = proposal.step as TransformStep;
    const before = columnValues(currentColumns, currentRows, column);
    const { columns: afterColumns, rows: afterRows, failureCount } = dryRunOneStep(currentColumns, currentRows, candidateStep);
    const failureRate = sampleSize > 0 ? failureCount / sampleSize : 0;
    const maxFailureRate = Math.max(MAX_FAILURE_RATE_MULTIPLIER * failureRate, MIN_MAX_FAILURE_RATE);

    const exceedsCoercionGuard = specialist === "coercion" && failureRate > COERCION_DROP_THRESHOLD;

    if (exceedsCoercionGuard) {
      stepReports.push({
        column,
        specialist,
        rationale: proposal.rationale,
        step: proposal.step,
        before,
        after: before,
        sampleSize,
        failureCount,
        failureRate,
        maxFailureRate,
        included: false,
        dropReason: `dry-run failure rate ${(failureRate * 100).toFixed(1)}% exceeds the 50% guard for a coercion step — likely a wrong transform.`,
      });
      skippedProposals.push({
        column,
        specialist,
        reason: `dry-run failure rate ${(failureRate * 100).toFixed(1)}% exceeds the 50% guard — dropped.`,
      });
      continue;
    }

    const after = columnValues(afterColumns, afterRows, column);
    stepReports.push({
      column,
      specialist,
      rationale: proposal.rationale,
      step: proposal.step,
      before,
      after,
      sampleSize,
      failureCount,
      failureRate,
      maxFailureRate,
      included: true,
    });

    const stepId = randomUUID();
    const stampedStep = updateStepProvenance(candidateStep, { source: "specialist", planId, specialist, model });
    ops.push({ kind: "addStep", nodeId, stepId, step: stampedStep, index: nextIndex });
    nextIndex += 1;

    currentColumns = afterColumns;
    currentRows = afterRows;
  }

  const includedCount = stepReports.filter((r) => r.included).length;
  const diff: PlanDiff = {
    summary: `Propose cleaning: ${includedCount} step${includedCount === 1 ? "" : "s"} (${missingValue.specialist} + ${coercion.specialist}) across ${nodeId}`,
    baseGraphVersion,
    ops,
  };

  return { diff, stepReports, skippedProposals };
}
