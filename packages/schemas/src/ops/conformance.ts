import type { CallFn, Expr } from "../expression.js";
import { buildFailureExpr } from "../expression.js";
import type { NiaTypeKind } from "../niaType.js";
import type { DestinationContract } from "../destinationContract.js";
import type { OnFailurePolicy } from "../nodeConfig.js";
import type { StepFailureReport } from "./types.js";
import { evalExpr } from "./residualEval.js";
import { computeFailureReport, rowFailed } from "./onFailure.js";
import { rowsToObjects, objRowsToArrays } from "../residualTransform.js";

/**
 * Schema layer, Part 5 — run-time conformance: the final implicit step that
 * casts each mapped/written value to its contract type, using the same
 * fallible coercion functions (expression.ts's FALLIBLE_CALL_FNS) and the
 * same onFailure machinery (computeFailureReport/rowFailed/buildFailureExpr)
 * every other fallible step already uses — onFailure defaults to
 * "quarantine", with counts like any fallible step (Part 5's own text).
 *
 * Only NiaTypeKinds with a fallible coercion function get an entry here.
 * string/bytes/json/object/array have no coercion call in FALLIBLE_CALL_FNS
 * (to_text never fails on non-null input) — those columns are skipped
 * entirely, per Part 5's "skip it for columns whose source and contract
 * types already match" clause: since the contract's niaType is itself
 * derived from the source schema (destinationContract.ts's own disclosed
 * deviation), a column with no cast function here is one where casting
 * would be a no-op anyway.
 */
const CONFORMANCE_CAST_FN: Partial<Record<NiaTypeKind, CallFn>> = {
  integer: "to_integer",
  float: "to_number",
  decimal: "to_number",
  boolean: "to_boolean",
  date: "to_date",
  timestamp: "to_date",
};

/**
 * Mirrors residualTransform.ts's applyResidualTransformsChunk shape exactly
 * (`{columns, rows, failures}` over array-of-arrays rows) so it slots into
 * runEtl.ts's existing write paths as one more step. `columns`/`rows` here
 * are the already-MAPPED destination-side columns (mapping.entries[].to),
 * matching contract.columns[].destinationName one-to-one.
 *
 * Processes contract.columns in order, one cast-and-filter pass per column:
 * for each row, the failure test (rowFailed) always runs against that row's
 * value as it stood BEFORE this column's cast — casting first and then
 * testing the (now-null-on-failure) cast value would make every failure
 * silently invisible, since a fallible call is defined to be non-failing on
 * null input. Kept rows get their field replaced by the cast value
 * (evalExpr, also against the pre-cast row); dropped/quarantined rows are
 * removed from the row set BEFORE the next column's pass, so one row that
 * fails two different columns' casts is reported/quarantined once, against
 * the first column that caught it, not twice.
 */
export function applyConformance(
  columns: string[],
  rows: unknown[][],
  contract: DestinationContract,
  policy: OnFailurePolicy = "quarantine",
): { columns: string[]; rows: unknown[][]; failures: StepFailureReport[] } {
  let objRows = rowsToObjects(columns, rows);
  const failures: StepFailureReport[] = [];

  for (const col of contract.columns) {
    const fn = CONFORMANCE_CAST_FN[col.niaType.kind];
    if (!fn) continue;
    if (!columns.includes(col.destinationName)) continue;

    const expr: Expr = { kind: "call", fn, args: [{ kind: "field", name: col.destinationName }] };
    const report = computeFailureReport(`conformance "${col.destinationName}"`, expr, objRows, policy);
    if (!report) continue;
    failures.push(report);

    const failureExpr = buildFailureExpr(expr)!;
    objRows = objRows
      .filter((row) => !((policy === "drop" || policy === "quarantine") && rowFailed(failureExpr, row)))
      .map((row) => ({ ...row, [col.destinationName]: evalExpr(expr, row) }));
  }

  return { columns: [...columns], rows: objRowsToArrays(columns, objRows), failures };
}
