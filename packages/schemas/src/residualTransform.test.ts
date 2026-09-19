import { describe, it, expect } from "vitest";
import { applyResidualTransforms } from "./residualTransform.js";
import { parseExpression } from "./expression.js";
import type { AggregateStep } from "./nodeConfig.js";

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
