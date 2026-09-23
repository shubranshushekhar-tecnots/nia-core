import { describe, it, expect } from "vitest";
import { applyResidualTransforms, applyResidualTransformsChunk } from "./residualTransform.js";
import { parseExpression } from "./expression.js";
import type { AggregateStep, ComputedFieldStep, FilterStep } from "./nodeConfig.js";
import { OnFailureAbortError } from "./ops/onFailure.js";

function expr(src: string) {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
}

describe("applyResidualTransforms — aggregate", () => {
  const columns = ["cohort", "salary", "dept"];
  const rows: unknown[][] = [
    ["eng", 100, "core"],
    ["eng", 200, "core"],
    ["eng", 150, "infra"],
    ["sales", 80, "core"],
    ["sales", 120, "core"],
  ];

  it("groups by one field and computes sum/avg/min/max/count", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [
        { fn: "count", field: null, alias: "n" },
        { fn: "sum", field: "salary", alias: "total" },
        { fn: "avg", field: "salary", alias: "avg_salary" },
        { fn: "min", field: "salary", alias: "min_salary" },
        { fn: "max", field: "salary", alias: "max_salary" },
      ],
    };

    const result = applyResidualTransforms(columns, rows, [step]);

    expect(result.columns).toEqual(["cohort", "n", "total", "avg_salary", "min_salary", "max_salary"]);

    const byCohort = Object.fromEntries(
      result.rows.map((r) => [r[result.columns.indexOf("cohort")], r]),
    );

    const eng = byCohort["eng"];
    expect(eng[result.columns.indexOf("n")]).toBe(3);
    expect(eng[result.columns.indexOf("total")]).toBe(450);
    expect(eng[result.columns.indexOf("avg_salary")]).toBeCloseTo(150);
    expect(eng[result.columns.indexOf("min_salary")]).toBe(100);
    expect(eng[result.columns.indexOf("max_salary")]).toBe(200);

    const sales = byCohort["sales"];
    expect(sales[result.columns.indexOf("n")]).toBe(2);
    expect(sales[result.columns.indexOf("total")]).toBe(200);
    expect(sales[result.columns.indexOf("avg_salary")]).toBeCloseTo(100);
  });

  it("groupBy: [] produces a single whole-table row", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: [],
      aggregations: [{ fn: "count", field: null, alias: "n" }],
    };

    const result = applyResidualTransforms(columns, rows, [step]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual([5]);
    expect(result.columns).toEqual(["n"]);
  });

  it("count_field only counts non-null values", () => {
    const colsWithNull = ["cohort", "bonus"];
    const rowsWithNull: unknown[][] = [
      ["eng", 10],
      ["eng", null],
      ["eng", 20],
    ];
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "count_field", field: "bonus", alias: "bonus_count" }],
    };

    const result = applyResidualTransforms(colsWithNull, rowsWithNull, [step]);
    expect(result.rows[0]![result.columns.indexOf("bonus_count")]).toBe(2);
  });

  it("count_distinct counts unique non-null values via a Set per group", () => {
    const colsD = ["cohort", "dept"];
    const rowsD: unknown[][] = [
      ["eng", "core"],
      ["eng", "core"],
      ["eng", "infra"],
      ["eng", null],
    ];
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "count_distinct", field: "dept", alias: "distinct_depts" }],
    };

    const result = applyResidualTransforms(colsD, rowsD, [step]);
    expect(result.rows[0]![result.columns.indexOf("distinct_depts")]).toBe(2);
  });

  it("having filters on an aggregation alias (ruling 2 shape)", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "sum", field: "salary", alias: "total" }],
      having: expr("total > 300"),
    };

    const result = applyResidualTransforms(columns, rows, [step]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![result.columns.indexOf("cohort")]).toBe("eng");
  });

  it("having filters on a groupBy field", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "count", field: null, alias: "n" }],
      having: expr('cohort = "sales"'),
    };

    const result = applyResidualTransforms(columns, rows, [step]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![result.columns.indexOf("cohort")]).toBe("sales");
  });

  it("chains after a filter step (residual composition)", () => {
    const result = applyResidualTransforms(columns, rows, [
      { kind: "filter", expr: expr('dept = "core"') },
      {
        kind: "aggregate",
        groupBy: ["cohort"],
        aggregations: [{ fn: "sum", field: "salary", alias: "total" }],
      },
    ]);

    const byCohort = Object.fromEntries(
      result.rows.map((r) => [r[result.columns.indexOf("cohort")], r]),
    );
    // eng's 150/infra row is filtered out before aggregation.
    expect(byCohort["eng"][result.columns.indexOf("total")]).toBe(300);
    expect(byCohort["sales"][result.columns.indexOf("total")]).toBe(200);
  });

  it("supports a multi-field groupBy key", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort", "dept"],
      aggregations: [{ fn: "count", field: null, alias: "n" }],
    };

    const result = applyResidualTransforms(columns, rows, [step]);
    expect(result.rows).toHaveLength(3); // eng/core, eng/infra, sales/core
  });
});

describe("applyResidualTransforms — onFailure failure reporting (Phase 8b-3)", () => {
  const cols = ["x"];
  const rowsWithOneFailure: unknown[][] = [["10"], ["abc"], [null]];

  it("onFailure: 'null' — row stays, field becomes null, failures reports count=1", () => {
    const step: ComputedFieldStep = {
      kind: "computed_field",
      name: "y",
      expression: expr("to_number(x)"),
      onFailure: "null",
    };

    const result = applyResidualTransforms(cols, rowsWithOneFailure, [step]);
    expect(result.rows).toHaveLength(3);
    expect(result.failures).toEqual([{ label: 'computed_field "y"', fns: ["to_number"], policy: "null", count: 1 }]);
  });

  it("onFailure: 'drop' — failing row is removed, failures still reports count=1", () => {
    const step: ComputedFieldStep = {
      kind: "computed_field",
      name: "y",
      expression: expr("to_number(x)"),
      onFailure: "drop",
    };

    const result = applyResidualTransforms(cols, rowsWithOneFailure, [step]);
    expect(result.rows).toHaveLength(2);
    expect(result.failures).toEqual([{ label: 'computed_field "y"', fns: ["to_number"], policy: "drop", count: 1 }]);
  });

  it("onFailure: 'fail' — throws OnFailureAbortError naming the step, function, and count", () => {
    const step: ComputedFieldStep = {
      kind: "computed_field",
      name: "y",
      expression: expr("to_number(x)"),
      onFailure: "fail",
    };

    expect(() => applyResidualTransforms(cols, rowsWithOneFailure, [step])).toThrow(OnFailureAbortError);
    expect(() => applyResidualTransforms(cols, rowsWithOneFailure, [step])).toThrow(
      'computed_field "y": to_number failed on 1 row(s).',
    );
  });

  it("absent onFailure defaults to 'fail'", () => {
    const step: ComputedFieldStep = { kind: "computed_field", name: "y", expression: expr("to_number(x)") };
    expect(() => applyResidualTransforms(cols, rowsWithOneFailure, [step])).toThrow(OnFailureAbortError);
  });

  it("a step with no fallible calls is unaffected, regardless of onFailure", () => {
    const step: FilterStep = { kind: "filter", expr: expr("x > 0"), onFailure: "fail" };
    const result = applyResidualTransforms(["x"], [[1], [-1], [2]], [step]);
    expect(result.failures).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });

  it("accumulates failures across multiple steps, in order", () => {
    const steps = [
      { kind: "computed_field", name: "y", expression: expr("to_number(x)"), onFailure: "null" } as ComputedFieldStep,
      { kind: "computed_field", name: "z", expression: expr("to_integer(x)"), onFailure: "null" } as ComputedFieldStep,
    ];

    const result = applyResidualTransforms(cols, rowsWithOneFailure, steps);
    expect(result.failures.map((f) => f.label)).toEqual(['computed_field "y"', 'computed_field "z"']);
    expect(result.failures.every((f) => f.count === 1)).toBe(true);
  });
});

describe("applyResidualTransformsChunk — stateful-op guard (Phase 9 Part 1)", () => {
  const columns = ["cohort", "salary"];
  const rows: unknown[][] = [
    ["eng", 100],
    ["sales", 80],
  ];

  it("rejects a stateful residual op (aggregate) run against a single chunk", () => {
    const step: AggregateStep = {
      kind: "aggregate",
      groupBy: ["cohort"],
      aggregations: [{ fn: "sum", field: "salary", alias: "total" }],
    };

    expect(() => applyResidualTransformsChunk(columns, rows, [step])).toThrow(
      /stateful residual op/,
    );
  });

  it("rejects even when the stateful op is preceded by row-local steps", () => {
    const steps = [
      { kind: "filter", expr: expr("salary > 0") } as FilterStep,
      {
        kind: "aggregate",
        groupBy: ["cohort"],
        aggregations: [{ fn: "sum", field: "salary", alias: "total" }],
      } as AggregateStep,
    ];

    expect(() => applyResidualTransformsChunk(columns, rows, steps)).toThrow(
      /stateful residual op/,
    );
  });

  it("runs normally (same output as applyResidualTransforms) when every step is row-local", () => {
    const steps = [{ kind: "filter", expr: expr('cohort = "eng"') } as FilterStep];

    const chunkResult = applyResidualTransformsChunk(columns, rows, steps);
    const fullResult = applyResidualTransforms(columns, rows, steps);
    expect(chunkResult).toEqual(fullResult);
    expect(chunkResult.rows).toEqual([["eng", 100]]);
  });
});
