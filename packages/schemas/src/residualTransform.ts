import type { Expr } from "./expression.js";
import type { AggregateStep, FilterCondition, TransformStep } from "./nodeConfig.js";

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
 */

function evalExpr(expr: Expr, row: Record<string, unknown>): unknown {
  switch (expr.kind) {
    case "field":
      return row[expr.name] ?? null;
    case "literal":
      return expr.value;
    case "binary": {
      const left = Number(evalExpr(expr.left, row));
      const right = Number(evalExpr(expr.right, row));
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
    case "call": {
      const args = expr.args.map((a) => evalExpr(a, row));
      if (expr.fn === "concat") return args.map((v) => (v ?? "")).join("");
      // coalesce
      for (const v of args) {
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
  }
}

function matchesCondition(cond: FilterCondition, row: Record<string, unknown>): boolean {
  const actual = row[cond.field];
  switch (cond.operator) {
    case "is_null":
      return actual === null || actual === undefined;
    case "is_not_null":
      return actual !== null && actual !== undefined;
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "gt":
      return Number(actual) > Number(cond.value);
    case "gte":
      return Number(actual) >= Number(cond.value);
    case "lt":
      return Number(actual) < Number(cond.value);
    case "lte":
      return Number(actual) <= Number(cond.value);
    case "contains":
      return typeof actual === "string" && typeof cond.value === "string" && actual.includes(cond.value);
  }
}

/**
 * Phase 6 Block 6 (ruling 3, docs/decisions.md): residual aggregation
 * buffers per-group state in memory — one accumulator entry per distinct
 * groupBy key seen in this chunk, plus (for `count_distinct`) a full `Set`
 * of every distinct value seen per group, for the lifetime of this call.
 * Pushdown-eligible aggregates (compiled to GROUP BY / $group by
 * pushdown.ts, executed by the source database) are strongly preferred —
 * they never hold this state in the worker process. Streaming/bounded-
 * memory aggregation (e.g. HyperLogLog for count_distinct, or a spill-to-
 * disk group map) is a real future item, ledgered in TODO.md, not
 * implemented here — a residual aggregate over a chunk with very high
 * cardinality groupBy values or very large per-group distinct sets can
 * exhaust worker memory. v1 accepts this because the runner's per-chunk
 * row cap (MAX_CHUNK_ROWS, apps/worker's queryBuilder.ts) already bounds
 * how many source rows a residual aggregate ever sees at once.
 */
function applyAggregateStep(objRows: Record<string, unknown>[], step: AggregateStep): { cols: string[]; rows: Record<string, unknown>[] } {
  type GroupState = {
    groupValues: Record<string, unknown>;
    count: number;
    fieldCounts: Map<string, number>;
    sums: Map<string, number>;
    mins: Map<string, number>;
    maxs: Map<string, number>;
    distinctSets: Map<string, Set<unknown>>;
  };

  const groups = new Map<string, GroupState>();

  for (const row of objRows) {
    const groupValues: Record<string, unknown> = {};
    for (const field of step.groupBy) groupValues[field] = row[field] ?? null;
    const key = JSON.stringify(step.groupBy.map((f) => groupValues[f]));

    let state = groups.get(key);
    if (!state) {
      state = { groupValues, count: 0, fieldCounts: new Map(), sums: new Map(), mins: new Map(), maxs: new Map(), distinctSets: new Map() };
      groups.set(key, state);
    }
    state.count += 1;

    for (const agg of step.aggregations) {
      const value = agg.field ? row[agg.field] : undefined;
      const present = value !== null && value !== undefined;
      switch (agg.fn) {
        case "count":
          break; // uses state.count directly below
        case "count_field":
          if (present) state.fieldCounts.set(agg.alias, (state.fieldCounts.get(agg.alias) ?? 0) + 1);
          break;
        case "count_distinct":
          if (present) {
            const set = state.distinctSets.get(agg.alias) ?? new Set<unknown>();
            set.add(value);
            state.distinctSets.set(agg.alias, set);
          }
          break;
        case "sum":
          state.sums.set(agg.alias, (state.sums.get(agg.alias) ?? 0) + Number(value ?? 0));
          break;
        case "avg":
          state.sums.set(agg.alias, (state.sums.get(agg.alias) ?? 0) + Number(value ?? 0));
          if (present) state.fieldCounts.set(agg.alias, (state.fieldCounts.get(agg.alias) ?? 0) + 1);
          break;
        case "min": {
          const num = Number(value);
          if (!Number.isNaN(num)) {
            const cur = state.mins.get(agg.alias);
            if (cur === undefined || num < cur) state.mins.set(agg.alias, num);
          }
          break;
        }
        case "max": {
          const num = Number(value);
          if (!Number.isNaN(num)) {
            const cur = state.maxs.get(agg.alias);
            if (cur === undefined || num > cur) state.maxs.set(agg.alias, num);
          }
          break;
        }
      }
    }
  }

  const cols = [...step.groupBy, ...step.aggregations.map((a) => a.alias)];
  let outRows: Record<string, unknown>[] = [];
  for (const state of groups.values()) {
    const outRow: Record<string, unknown> = { ...state.groupValues };
    for (const agg of step.aggregations) {
      switch (agg.fn) {
        case "count":
          outRow[agg.alias] = state.count;
          break;
        case "count_field":
          outRow[agg.alias] = state.fieldCounts.get(agg.alias) ?? 0;
          break;
        case "count_distinct":
          outRow[agg.alias] = state.distinctSets.get(agg.alias)?.size ?? 0;
          break;
        case "sum":
          outRow[agg.alias] = state.sums.get(agg.alias) ?? 0;
          break;
        case "avg": {
          const sum = state.sums.get(agg.alias) ?? 0;
          const count = state.fieldCounts.get(agg.alias) ?? 0;
          outRow[agg.alias] = count > 0 ? sum / count : null;
          break;
        }
        case "min":
          outRow[agg.alias] = state.mins.get(agg.alias) ?? null;
          break;
        case "max":
          outRow[agg.alias] = state.maxs.get(agg.alias) ?? null;
          break;
      }
    }
    outRows.push(outRow);
  }

  // ruling 2: having may only reference an aggregation alias or a groupBy
  // field — both are now plain top-level keys on outRow, so matchesCondition
  // (the same helper filter steps use) applies directly, no special-casing.
  if (step.having && step.having.length > 0) {
    outRows = outRows.filter((row) => step.having!.every((cond) => matchesCondition(cond, row)));
  }

  return { cols, rows: outRows };
}

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
    if (step.kind === "filter") {
      objRows = objRows.filter((row) => step.conditions.every((cond) => matchesCondition(cond, row)));
    } else if (step.kind === "computed_field") {
      if (!cols.includes(step.name)) cols = [...cols, step.name];
      objRows = objRows.map((row) => ({ ...row, [step.name]: evalExpr(step.expression, row) }));
    } else if (step.kind === "drop_fields") {
      cols = cols.filter((c) => !step.fields.includes(c));
      objRows = objRows.map((row) => {
        const next = { ...row };
        for (const f of step.fields) delete next[f];
        return next;
      });
    } else if (step.kind === "aggregate") {
      const result = applyAggregateStep(objRows, step);
      cols = result.cols;
      objRows = result.rows;
    }
  }

  const outRows = objRows.map((row) => cols.map((c) => row[c] ?? null));
  return { columns: cols, rows: outRows };
}
