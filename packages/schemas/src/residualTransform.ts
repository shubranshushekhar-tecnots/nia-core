import type { TransformStep } from "./nodeConfig.js";
import { opForStep } from "./ops/registry.js";

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
 */

export function applyResidualTransforms(
  columns: string[],
  rows: unknown[][],
  steps: TransformStep[],
): { columns: string[]; rows: unknown[][] } {
  let cols = [...columns];
  let objRows: Record<string, unknown>[] = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });

  for (const step of steps) {
    const result = opForStep(step).applyResidual({ cols, rows: objRows }, step);
    cols = result.cols;
    objRows = result.rows;
  }

  const outRows = objRows.map((row) => cols.map((c) => row[c] ?? null));
  return { columns: cols, rows: outRows };
}
