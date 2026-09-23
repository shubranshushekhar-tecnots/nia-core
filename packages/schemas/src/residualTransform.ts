import type { TransformStep } from "./nodeConfig.js";
import { opForStep } from "./ops/registry.js";
import type { StepFailureReport } from "./ops/types.js";

/**
 * In-process executor for the transform steps a pushdown compiler
 * (pushdown.ts) couldn't push into the source query — either because the
 * source has no compiler for its dialect, or (Phase 6 Block 3) because the
 * runner is deliberately skipping pushdown for a multi-transform-node chain
 * (see apps/worker/src/lib/etl/runEtl.ts). Unlike runPreview.ts's
 * buildPreviewQuery (which only ever *counts* residual steps for a >1-node
 * chain, never runs them), this module actually executes every step, in
 * order, against real fetched rows — the real ETL runner needs correct
 * output, not just a preview count.
 *
 * Steps run in array order, each seeing the previous step's output shape
 * (same contract TransformConfig.steps already documents for pushdown).
 *
 * Phase 8a: each step's actual per-row logic now lives on its op module's
 * `applyResidual` (ops/registry.ts) — this file is just the array<->object
 * row-shape conversion plus the per-step dispatch loop. The generic
 * per-row eval helpers (`evalExpr`/`matchesCondition`) op modules share
 * live in ops/residualEval.ts.
 *
 * Phase 8b-3: also collects each step's optional `failures` report (fail/
 * quarantine already threw inside applyResidual before returning — see
 * onFailure.ts's computeFailureReport — so anything collected here is
 * already a "the run may continue" null/drop count) into a flat array, in
 * step order, for the caller (runEtl.ts) to fold into the run result.
 */

export function applyResidualTransforms(
  columns: string[],
  rows: unknown[][],
  steps: TransformStep[],
): { columns: string[]; rows: unknown[][]; failures: StepFailureReport[] } {
  let cols = [...columns];
  let objRows: Record<string, unknown>[] = rowsToObjects(cols, rows);
  const failures: StepFailureReport[] = [];

  for (const step of steps) {
    const result = opForStep(step).applyResidual({ cols, rows: objRows }, step);
    cols = result.cols;
    objRows = result.rows;
    if (result.failures) failures.push(...result.failures);
  }

  return { columns: cols, rows: objRowsToArrays(cols, objRows), failures };
}

/**
 * Phase 9 Part 1: array-rows -> object-rows, the same conversion
 * applyResidualTransforms/applyResidualTransformsChunk each do internally
 * — pulled out so runEtl.ts's per-chunk accumulator-feeding path (which
 * needs object rows to call an op's createAccumulator().feed() directly,
 * without going through either full executor) doesn't duplicate it.
 */
export function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

/** The inverse of rowsToObjects — see that function's doc comment. */
export function objRowsToArrays(columns: string[], rows: Record<string, unknown>[]): unknown[][] {
  return rows.map((row) => columns.map((c) => row[c] ?? null));
}

/**
 * Phase 9 Part 1: chunk-scoped residual executor for runEtl.ts's per-page
 * row-local prefix (the steps ahead of the first stateful op, if any —
 * see runEtl.ts). Hard-errors if any given step's op is
 * `residualExecution: "stateful"` (today: aggregate) — such an op needs
 * every input row to produce correct output (a group's rows can span
 * multiple chunks), so running it against a single chunk here would
 * silently reproduce the exact bug this function exists to prevent.
 * runEtl.ts is responsible for stopping at the first stateful step and
 * handling it via that op's createAccumulator instead of calling this
 * function on it.
 *
 * Deliberately a separate function from applyResidualTransforms (not a
 * flag on it): that function's existing complete-dataset callers
 * (ops-agreement.ts, agreementCases.ts's live suite, collation-probe.ts,
 * and this package's own residualTransform.test.ts) legitimately run
 * aggregate steps against a full dataset in one call and must keep doing
 * so unguarded.
 */
export function applyResidualTransformsChunk(
  columns: string[],
  rows: unknown[][],
  steps: TransformStep[],
): { columns: string[]; rows: unknown[][]; failures: StepFailureReport[] } {
  for (const step of steps) {
    if (opForStep(step).residualExecution === "stateful") {
      throw new Error(
        `applyResidualTransformsChunk: step "${step.kind}" is a stateful residual op and cannot run against a single chunk — it needs every input row (see runEtl.ts's stateful-op split).`,
      );
    }
  }
  return applyResidualTransforms(columns, rows, steps);
}
