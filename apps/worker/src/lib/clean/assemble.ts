import { randomUUID } from "node:crypto";
import {
  applyResidualTransforms,
  evalExpr,
  updateStepProvenance,
  DATE_FORMAT_CANDIDATES,
  type AddStepOp,
  type ColumnStats,
  type ComputedFieldStep,
  type Expr,
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

/**
 * Phase 13 follow-up, item 2 — a coercion-specialist date column where a
 * per-value re-check of DD/MM/YYYY vs. MM/DD/YYYY against the dry-run
 * sample found no row that rules exactly one of the two formats out (see
 * buildDateExpression below), so neither format can be ruled out. Surfaced
 * here (and, in human-readable form, via skippedProposals) instead of the
 * assembler silently guessing one, or silently mixing both into the same
 * coalesce chain — needs a human choice between the two.
 */
export interface AmbiguousDateColumn {
  column: string;
  reason: string;
  candidates: { key: string; token: string; passRate: number }[];
}

export interface AssembleResult {
  diff: PlanDiff;
  stepReports: StepDryRunReport[];
  /** Proposals that never became a step at all — the specialist's own "no-change"/"dropped" outcomes, surfaced here for the UI (Step 7 lists skipped/failed columns alongside the diff). */
  skippedProposals: DroppedProposalReport[];
  /** Coercion date columns needing a human format choice — see AmbiguousDateColumn's doc comment. */
  ambiguousDateColumns: AmbiguousDateColumn[];
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
  /** Per-column profiler stats (same input the specialists themselves were prompted with) — used to build the date coalesce chain below; not otherwise consulted by this module. Required: both production callers (proposeCleaning.ts, run-clean-eval.ts) always have this available from computeColumnStats, so a caller that forgot to thread it through is a bug, not a legitimate no-date-column case — pass `[]` explicitly when there's no date coercion in play. */
  columns: ColumnStats[];
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
 * True iff `expr` is exactly the plain, unformatted `to_date(field)` marker
 * the coercion specialist emits (per its prompt) for a column it identified
 * as needing date coercion — never a wrapped/nested shape. The assembler
 * treats this bare marker as a placeholder to replace with the real
 * multi-format-fallback chain built from the profiler's own per-format
 * parse-rate stats (see buildDateExpression below).
 */
function isDateMarkerExpr(expr: Expr, column: string): boolean {
  return (
    expr.kind === "call" &&
    expr.fn === "to_date" &&
    expr.args.length === 1 &&
    expr.args[0]!.kind === "field" &&
    expr.args[0]!.name === column
  );
}

interface DateChainResult {
  ambiguous?: AmbiguousDateColumn;
  expr?: Expr;
}

/** True iff `expr` evaluated against `{ [column]: value }` parses (non-null). */
function parsesAs(column: string, value: unknown, token: string): boolean {
  const expr: Expr = { kind: "call", fn: "parse_date", args: [{ kind: "field", name: column }, { kind: "literal", value: token }] };
  return evalExpr(expr, { [column]: value }) !== null;
}

/**
 * Builds the replacement expression for a coercion specialist's bare
 * `to_date(field)` marker, from the column's profiled per-format parse
 * rates plus (when DD/MM/YYYY and MM/DD/YYYY are both in play) a direct
 * per-value re-check against the dry-run sample (Phase 13 follow-up,
 * item 2):
 *
 * - A resulting coalesce chain may never contain BOTH parse_date_dmy and
 *   parse_date_mdy — a value that parses under both really is ambiguous,
 *   and the aggregate parseRates counts alone can't tell whether the SAME
 *   rows pass both formats or DIFFERENT rows each pass exactly one (e.g. a
 *   column mixing ISO dates with slash dates: both dmy/mdy would show
 *   sub-100% aggregate pass rates without ever being 100%, but the slash
 *   rows within it could still all be simultaneously DD/MM- and MM/DD-
 *   parseable). So whenever both candidates have at least one passing row
 *   at all, re-evaluate parse_date(field, token) per row in `values` and
 *   count how many rows parse under EXACTLY ONE of the two:
 *     - exactly one format has such rows -> that format rules the other
 *       out for at least one real value, so use it and drop the other
 *       from the chain entirely (never both).
 *     - neither format has such rows (every row that parses at all parses
 *       under both) -> nothing rules either out -> needs a human choice.
 *     - both formats have such rows (some rows only fit dmy, others only
 *       fit mdy) -> contradictory evidence -> needs a human choice.
 * - Otherwise (or once the exclusion above is applied), every remaining
 *   DATE_FORMAT_CANDIDATES entry with a nonzero pass count becomes one
 *   `parse_date(field, token)` call, ranked highest-pass-rate first (ties
 *   keep DATE_FORMAT_CANDIDATES's declared order — iso, dmy, mdy,
 *   ymd_slash — since Array#sort is stable and the candidates are mapped
 *   in that order before sorting); more than one surviving candidate is
 *   wrapped in coalesce(...), exactly one is used directly.
 * - If no candidate ever passes, `expr` is omitted entirely — the caller
 *   falls back to leaving the original to_date(field) marker in place, and
 *   the existing dry-run failure-rate guard naturally drops it.
 */
function buildDateExpression(column: string, values: unknown[], stats: ColumnStats | undefined): DateChainResult {
  const parseRates = stats?.parseRates;
  if (!parseRates) return {};

  const dmy = parseRates.parse_date_dmy;
  const mdy = parseRates.parse_date_mdy;
  let excludeKey: "parse_date_dmy" | "parse_date_mdy" | null = null;

  if (dmy && mdy && dmy.passed > 0 && mdy.passed > 0) {
    let dmyOnly = 0;
    let mdyOnly = 0;
    for (const v of values) {
      const dmyOk = parsesAs(column, v, "DD/MM/YYYY");
      const mdyOk = parsesAs(column, v, "MM/DD/YYYY");
      if (dmyOk && !mdyOk) dmyOnly += 1;
      else if (mdyOk && !dmyOk) mdyOnly += 1;
    }

    if (dmyOnly > 0 && mdyOnly === 0) {
      excludeKey = "parse_date_mdy";
    } else if (mdyOnly > 0 && dmyOnly === 0) {
      excludeKey = "parse_date_dmy";
    } else {
      const reason =
        dmyOnly > 0 && mdyOnly > 0
          ? `ambiguous date format: DD/MM/YYYY and MM/DD/YYYY each rule the other out for some values (${dmyOnly} value(s) parse only as DD/MM/YYYY, ${mdyOnly} only as MM/DD/YYYY) — needs a human choice between the two formats`
          : `ambiguous date format: DD/MM/YYYY and MM/DD/YYYY parse the same values in the sample (neither ever rules the other out) — needs a human choice between the two formats`;
      return {
        ambiguous: {
          column,
          reason,
          candidates: [
            { key: "parse_date_dmy", token: "DD/MM/YYYY", passRate: dmy.passed / dmy.attempted },
            { key: "parse_date_mdy", token: "MM/DD/YYYY", passRate: mdy.passed / mdy.attempted },
          ],
        },
      };
    }
  }

  const fieldExpr: Expr = { kind: "field", name: column };
  // Non-null: computeColumnStats (stats.ts) always populates every
  // DATE_FORMAT_CANDIDATES key alongside every COERCION_PARSE_KEYS key in
  // the same loop, never partially — see this file's ColumnStats.parseRates
  // doc reference above.
  const surviving = DATE_FORMAT_CANDIDATES.filter((c) => c.key !== excludeKey)
    .map((c) => ({ ...c, rate: parseRates[c.key]! }))
    .filter((c) => c.rate.passed > 0)
    .sort((a, b) => b.rate.passed / b.rate.attempted - a.rate.passed / a.rate.attempted);

  if (surviving.length === 0) return {};

  const calls: Expr[] = surviving.map((c) => ({
    kind: "call",
    fn: "parse_date",
    args: [fieldExpr, { kind: "literal", value: c.token }],
  }));

  const expr: Expr = calls.length === 1 ? calls[0]! : { kind: "call", fn: "coalesce", args: calls };
  return { expr };
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
  const { nodeId, planId, model, baseGraphVersion, existingStepCount, sampleColumns, sampleRows, missingValue, coercion, columns } = input;

  const ordered = orderedStepProposals(missingValue, coercion);
  const skippedProposals = [...skippedFromResult(missingValue), ...skippedFromResult(coercion)];
  const ambiguousDateColumns: AmbiguousDateColumn[] = [];
  const columnStatsByName = new Map(columns.map((c) => [c.name, c]));

  let currentColumns = sampleColumns;
  let currentRows = sampleRows;
  const sampleSize = sampleRows.length;

  const stepReports: StepDryRunReport[] = [];
  const ops: AddStepOp[] = [];
  let nextIndex = existingStepCount;

  for (const { column, specialist, proposal } of ordered) {
    let effectiveProposal = proposal;
    const before = columnValues(currentColumns, currentRows, column);

    // Phase 13, Step 5 (rule refined by Phase 13 follow-up, item 2) — the
    // coercion specialist emits a bare to_date(field) marker for any date
    // column; replace it here with the real multi-format-fallback chain
    // built from the profiler's own per-format parse rates (never
    // something the model itself decides).
    if (specialist === "coercion" && isDateMarkerExpr(proposal.step.expression, column)) {
      const { ambiguous, expr } = buildDateExpression(column, before, columnStatsByName.get(column));
      if (ambiguous) {
        ambiguousDateColumns.push(ambiguous);
        skippedProposals.push({ column, specialist, reason: ambiguous.reason });
        continue;
      }
      if (expr) {
        effectiveProposal = { ...proposal, step: { ...proposal.step, expression: expr } };
      }
      // No candidate ever passed at all: fall through with the original
      // to_date(field) marker unchanged — the existing dry-run guard below
      // naturally drops it if it fails too often.
    }

    const candidateStep = effectiveProposal.step as TransformStep;
    const { columns: afterColumns, rows: afterRows, failureCount } = dryRunOneStep(currentColumns, currentRows, candidateStep);
    const failureRate = sampleSize > 0 ? failureCount / sampleSize : 0;
    const maxFailureRate = Math.max(MAX_FAILURE_RATE_MULTIPLIER * failureRate, MIN_MAX_FAILURE_RATE);

    const exceedsCoercionGuard = specialist === "coercion" && failureRate > COERCION_DROP_THRESHOLD;

    if (exceedsCoercionGuard) {
      stepReports.push({
        column,
        specialist,
        rationale: effectiveProposal.rationale,
        step: effectiveProposal.step,
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
      rationale: effectiveProposal.rationale,
      step: effectiveProposal.step,
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

  return { diff, stepReports, skippedProposals, ambiguousDateColumns };
}
