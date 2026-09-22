/**
 * Phase 13, Step 8 — eval:clean. For each `eval/clean/<dataset>` corpus
 * entry: profile the whole input, route (Step 3), propose via the real
 * LLM specialists (Step 4), assemble + dry-run (Step 5), then actually RUN
 * the assembled steps against the full input via the residual evaluator
 * (packages/schemas/src/residualTransform.ts) and compare cell-by-cell to
 * expected.json. Run with:
 *   npx tsx scripts/run-clean-eval.ts
 * (reads apps/worker/.env via dotenv/config transitively through env.ts;
 * needs NIA_GATEWAY_* configured — no DB/connector/docker dependency at
 * all, since computeColumnStats/routeColumns/the specialists/
 * buildAssembledPlan/applyResidualTransforms are all pure functions over
 * in-memory rows).
 *
 * Deliberately runs each dataset ONCE (not twice, despite phase13.md Step
 * 8's text) — explicit instruction override for this run, to keep LLM
 * spend/test time lean. The "did the two runs match" report column is
 * therefore reported as "n/a (single run)" rather than computed.
 *
 * Rows are joined between input/expected/actual by `id` (every dataset
 * has one, and it's always in `mustNotChange`) rather than by array
 * index, since a step with onFailure "quarantine"/"drop" removes failing
 * rows from the output entirely (computedField.ts's applyResidual) — an
 * index-based comparison would silently misalign every row after the
 * first quarantined one.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddStepOp, TransformStep } from "@nia/schemas";
import { applyResidualTransforms } from "@nia/schemas";
import { computeColumnStats } from "../src/lib/profile/stats.js";
import { routeColumns } from "../src/lib/clean/router.js";
import { proposeMissingValueCleaning } from "../src/lib/clean/missingValueSpecialist.js";
import { proposeCoercionCleaning } from "../src/lib/clean/coercionSpecialist.js";
import { buildAssembledPlan } from "../src/lib/clean/assemble.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(__dirname, "../../../eval/clean");

interface Meta {
  description: string;
  mustNotChange: string[];
  reviewed: boolean;
}

type Row = Record<string, unknown>;

interface CellMismatch {
  id: unknown;
  column: string;
  expected: unknown;
  actual: unknown;
  hardFailure: boolean;
}

interface DatasetReport {
  dataset: string;
  provisional: boolean;
  totalRows: number;
  totalCells: number;
  cellAccuracy: number;
  hardFailures: CellMismatch[];
  otherMismatches: CellMismatch[];
  columnsWronglyChanged: string[];
  columnsMissed: string[];
  droppedRowIds: unknown[];
  failureCounts: { label: string; policy: string; count: number }[];
  expectedFailureCount: number;
  actualFailureCount: number;
  pass: boolean;
}

function loadDataset(dir: string): { meta: Meta; input: Row[]; expected: Row[] } {
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as Meta;
  const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8")) as Row[];
  const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Row[];
  return { meta, input, expected };
}

function columnNames(rows: Row[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

function inferDeclaredType(values: unknown[]): string {
  const first = values.find((v) => v !== null && v !== undefined);
  return first === undefined ? "unknown" : typeof first;
}

/** Normalizes a residual-evaluator output cell for comparison against expected.json's plain-JSON values (Date -> ISO string, undefined -> null). */
function normalizeCell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runDataset(name: string, dir: string): Promise<DatasetReport> {
  const { meta, input, expected } = loadDataset(dir);
  const mustNotChange = new Set(meta.mustNotChange);

  const cols = columnNames(input);
  const columns = cols.map((name) => computeColumnStats(name, inferDeclaredType(input.map((r) => r[name])), input.map((r) => r[name])));
  const routes = routeColumns(columns);

  const [missingValue, coercion] = await Promise.all([
    proposeMissingValueCleaning(columns, routes),
    proposeCoercionCleaning(columns, routes),
  ]);

  const sampleRows = input.map((row) => cols.map((c) => row[c]));
  const assembled = buildAssembledPlan({
    nodeId: `eval-${name}`,
    planId: randomUUID(),
    baseGraphVersion: 0,
    existingStepCount: 0,
    sampleColumns: cols,
    sampleRows,
    missingValue,
    coercion,
  });

  const steps: TransformStep[] = assembled.diff.ops
    .filter((op): op is AddStepOp => op.kind === "addStep")
    .map((op) => op.step);

  const { columns: outCols, rows: outRows, failures } = applyResidualTransforms(cols, sampleRows, steps);

  const inputById = new Map(input.map((r) => [r.id, r]));
  const expectedById = new Map(expected.map((r) => [r.id, r]));
  const actualById = new Map(
    outRows.map((row) => {
      const obj: Row = {};
      outCols.forEach((c, i) => (obj[c] = normalizeCell(row[i])));
      return [obj.id, obj] as const;
    }),
  );

  const hardFailures: CellMismatch[] = [];
  const otherMismatches: CellMismatch[] = [];
  const droppedRowIds: unknown[] = [];
  const columnsWronglyChangedSet = new Set<string>();
  let totalCells = 0;

  const changedAnywhere = new Set<string>(); // columns actual differs from input on ANY row
  const shouldHaveChangedAnywhere = new Set<string>(); // columns expected differs from input on ANY row

  for (const [id, expectedRow] of expectedById) {
    const inputRow = inputById.get(id);
    const actualRow = actualById.get(id);
    if (!actualRow) {
      droppedRowIds.push(id);
      continue;
    }
    for (const column of Object.keys(expectedRow)) {
      totalCells += 1;
      const expectedVal = expectedRow[column];
      const actualVal = actualRow[column];
      const inputVal = inputRow?.[column];

      if (!deepEqual(inputVal, expectedVal)) shouldHaveChangedAnywhere.add(column);
      if (!deepEqual(inputVal, actualVal)) changedAnywhere.add(column);

      if (!deepEqual(expectedVal, actualVal)) {
        const isHard = mustNotChange.has(column) && !deepEqual(inputVal, actualVal);
        const mismatch: CellMismatch = { id, column, expected: expectedVal, actual: actualVal, hardFailure: isHard };
        if (isHard) {
          hardFailures.push(mismatch);
          columnsWronglyChangedSet.add(column);
        } else {
          otherMismatches.push(mismatch);
        }
      }
    }
  }

  // A mustNotChange column can also be wrongly changed without producing an
  // expected-vs-actual mismatch in the loop above only if expected.json
  // itself were wrong (it shouldn't be) — this second pass catches that
  // independently of expected.json, comparing actual directly to input.
  for (const column of mustNotChange) {
    if (!changedAnywhere.has(column)) continue;
    for (const [id, inputRow] of inputById) {
      const actualRow = actualById.get(id);
      if (!actualRow) continue;
      if (!deepEqual(inputRow[column], actualRow[column])) {
        columnsWronglyChangedSet.add(column);
      }
    }
  }

  const columnsMissed = [...shouldHaveChangedAnywhere].filter((c) => !mustNotChange.has(c) && !changedAnywhere.has(c));

  const failureCounts = failures.map((f) => ({ label: f.label, policy: f.policy, count: f.count }));
  const actualFailureCount = failures.reduce((sum, f) => sum + f.count, 0);
  const expectedFailureCount = 0; // none of the 10 datasets' meta.json documents an expected quarantine/drop/fail count

  const pass =
    hardFailures.length === 0 &&
    otherMismatches.length === 0 &&
    droppedRowIds.length === 0 &&
    actualFailureCount === expectedFailureCount &&
    columnsMissed.length === 0;

  return {
    dataset: name,
    provisional: !meta.reviewed,
    totalRows: expected.length,
    totalCells,
    cellAccuracy: totalCells === 0 ? 1 : (totalCells - hardFailures.length - otherMismatches.length) / totalCells,
    hardFailures,
    otherMismatches,
    columnsWronglyChanged: [...columnsWronglyChangedSet],
    columnsMissed,
    droppedRowIds,
    failureCounts,
    expectedFailureCount,
    actualFailureCount,
    pass,
  };
}

function printReport(reports: DatasetReport[]) {
  console.log("\n=== eval:clean report (each dataset run once) ===\n");

  const allHardFailures = reports.flatMap((r) => r.hardFailures.map((h) => ({ dataset: r.dataset, ...h })));
  if (allHardFailures.length > 0) {
    console.log(`HARD FAILURES (mustNotChange column changed) — ${allHardFailures.length}:`);
    for (const h of allHardFailures) {
      console.log(`  [${h.dataset}] id=${JSON.stringify(h.id)} column=${h.column}: expected ${JSON.stringify(h.expected)}, got ${JSON.stringify(h.actual)}`);
    }
    console.log("");
  } else {
    console.log("HARD FAILURES: none\n");
  }

  for (const r of reports) {
    console.log(`--- ${r.dataset}${r.provisional ? " [PROVISIONAL, unreviewed]" : ""} ---`);
    console.log(`  cell accuracy: ${(r.cellAccuracy * 100).toFixed(1)}% (${r.totalCells} cells, ${r.totalRows} rows)`);
    console.log(`  columns wrongly changed (mustNotChange): ${r.columnsWronglyChanged.length ? r.columnsWronglyChanged.join(", ") : "none"}`);
    console.log(`  columns missed (should have changed, didn't): ${r.columnsMissed.length ? r.columnsMissed.join(", ") : "none"}`);
    console.log(`  failure/quarantine counts: actual=${r.actualFailureCount} expected=${r.expectedFailureCount}${r.failureCounts.length ? " (" + r.failureCounts.map((f) => `${f.label}:${f.policy}=${f.count}`).join(", ") + ")" : ""}`);
    if (r.droppedRowIds.length > 0) console.log(`  rows dropped from output (quarantine/drop): ${JSON.stringify(r.droppedRowIds)}`);
    if (r.otherMismatches.length > 0) {
      console.log(`  other mismatches (${r.otherMismatches.length}):`);
      for (const m of r.otherMismatches.slice(0, 10)) {
        console.log(`    id=${JSON.stringify(m.id)} column=${m.column}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}`);
      }
      if (r.otherMismatches.length > 10) console.log(`    ... and ${r.otherMismatches.length - 10} more`);
    }
    console.log(`  runs matched: n/a (single run per Step 8 override)`);
    console.log(`  result: ${r.pass ? "PASS" : "FAIL"}\n`);
  }

  const passed = reports.filter((r) => r.pass).length;
  console.log(`${passed}/${reports.length} datasets passed.`);
  const provisionalCount = reports.filter((r) => r.provisional).length;
  if (provisionalCount > 0) console.log(`${provisionalCount} dataset(s) unreviewed — marked provisional above.`);
}

async function main() {
  const datasetNames = readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const reports: DatasetReport[] = [];
  for (const name of datasetNames) {
    console.log(`running ${name}...`);
    reports.push(await runDataset(name, path.join(CORPUS_ROOT, name)));
  }

  printReport(reports);

  const hardFailureCount = reports.reduce((sum, r) => sum + r.hardFailures.length, 0);
  const allPassed = reports.every((r) => r.pass);
  process.exit(hardFailureCount === 0 && allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("eval:clean run crashed:", err);
  process.exit(1);
});
