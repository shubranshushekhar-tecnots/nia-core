import { describe, expect, it } from "vitest";
import { compilePushdown, manifestDialect } from "./pushdown.js";
import type { TransformConfig } from "./nodeConfig.js";
import { parseExpression } from "./expression.js";

function expr(src: string) {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
}

/** Mirrors pushdown.ts's own quoteIdent/placeholder — kept local (not imported) since those helpers aren't exported; used to build dialect-agnostic expected-SQL strings for the describe.each blocks below, so every aggregate case runs against BOTH SQL dialects with one assertion body instead of two hand-duplicated copies. */
function q(dialect: "mysql" | "postgres", name: string): string {
  return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}
function ph(dialect: "mysql" | "postgres", n: number): string {
  return dialect === "mysql" ? "?" : `$${n}`;
}

describe("manifestDialect", () => {
  it("maps the 3 shipped connectors to their query dialect", () => {
    expect(manifestDialect("mysql")).toBe("mysql");
    expect(manifestDialect("supabase")).toBe("postgres");
    expect(manifestDialect("mongodb")).toBe("mongo");
  });
  it("returns null for an unknown/future manifest", () => {
    expect(manifestDialect("snowflake")).toBeNull();
    expect(manifestDialect(undefined)).toBeNull();
  });
});

describe("compilePushdown — no dialect / empty config", () => {
  it("is entirely residual when dialect is null", () => {
    const config: TransformConfig = { steps: [{ kind: "filter", conditions: [{ field: "age", operator: "gt", value: 30 }] }] };
    const plan = compilePushdown(null, config);
    expect(plan.dialectQuery).toBeNull();
    expect(plan.pushedDownCount).toBe(0);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms).toEqual(config.steps);
  });

  it("is a no-op (nothing pushed, nothing residual) for an empty step list", () => {
    const plan = compilePushdown("mysql", { steps: [] });
    expect(plan.dialectQuery).toBeNull();
    expect(plan.pushedDownCount).toBe(0);
    expect(plan.residualCount).toBe(0);
  });
});

describe("compilePushdown — filter, both SQL dialects", () => {
  const config: TransformConfig = {
    steps: [{ kind: "filter", conditions: [{ field: "age", operator: "gt", value: 30 }, { field: "name", operator: "eq", value: "Ada" }] }],
  };

  it("mysql: backtick-quoted identifiers, ? placeholders", () => {
    const plan = compilePushdown("mysql", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(0);
    expect(plan.dialectQuery).toEqual({
      dialect: "mysql",
      whereSql: "(`age` > ?) AND (`name` = ?)",
      selectSql: null,
      params: [30, "Ada"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
  });

  it("postgres: double-quoted identifiers, $n placeholders", () => {
    const plan = compilePushdown("postgres", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "postgres",
      whereSql: '("age" > $1) AND ("name" = $2)',
      selectSql: null,
      params: [30, "Ada"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
  });

  it("mongo: $match with $and of per-condition operators", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $match: { $and: [{ age: { $gt: 30 } }, { name: { $eq: "Ada" } }] } }],
      isAggregate: false,
    });
  });

  it("contains -> LIKE %..% (sql) / escaped $regex (mongo)", () => {
    const containsConfig: TransformConfig = { steps: [{ kind: "filter", conditions: [{ field: "email", operator: "contains", value: "a.b+c" }] }] };
    const mysqlPlan = compilePushdown("mysql", containsConfig);
    expect(mysqlPlan.dialectQuery).toEqual({
      dialect: "mysql",
      whereSql: "(`email` LIKE ?)",
      selectSql: null,
      params: ["%a.b+c%"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });

    const mongoPlan = compilePushdown("mongo", containsConfig);
    expect(mongoPlan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $match: { email: { $regex: "a\\.b\\+c", $options: "i" } } }],
      isAggregate: false,
    });
  });

  it("is_null / is_not_null carry no param", () => {
    const config2: TransformConfig = { steps: [{ kind: "filter", conditions: [{ field: "deleted_at", operator: "is_null" }] }] };
    const plan = compilePushdown("postgres", config2);
    expect(plan.dialectQuery).toEqual({
      dialect: "postgres",
      whereSql: '("deleted_at" IS NULL)',
      selectSql: null,
      params: [],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
  });
});

describe("compilePushdown — computed_field, both SQL dialects + mongo", () => {
  const config: TransformConfig = {
    steps: [{ kind: "computed_field", name: "full_name", expression: expr('concat(first, " ", last)') }],
  };

  it("mysql/postgres: CONCAT(...) AS alias, string literals parameterized", () => {
    const mysqlPlan = compilePushdown("mysql", config);
    expect(mysqlPlan.dialectQuery).toEqual({
      dialect: "mysql",
      whereSql: null,
      selectSql: "CONCAT(`first`, ?, `last`) AS `full_name`",
      params: [" "],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
  });

  it("mongo: $addFields with $concat", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $addFields: { full_name: { $concat: ["$first", " ", "$last"] } } }],
      isAggregate: false,
    });
  });

  it("coalesce + arithmetic nesting compiles on both dialect families", () => {
    const nested: TransformConfig = {
      steps: [{ kind: "computed_field", name: "total", expression: expr("coalesce(price, 0) * qty") }],
    };
    const sql = compilePushdown("postgres", nested);
    expect(sql.dialectQuery).toEqual({
      dialect: "postgres",
      whereSql: null,
      selectSql: '(COALESCE("price", $1) * "qty") AS "total"',
      params: [0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
    const mongo = compilePushdown("mongo", nested);
    expect(mongo.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $addFields: { total: { $multiply: [{ $ifNull: ["$price", 0] }, "$qty"] } } }],
      isAggregate: false,
    });
  });
});

describe("compilePushdown — drop_fields asymmetry (mongo pushable, SQL residual)", () => {
  const config: TransformConfig = { steps: [{ kind: "drop_fields", fields: ["ssn", "internal_notes"] }] };

  it("mongo pushes drop_fields down as a $project exclusion", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(0);
    expect(plan.dialectQuery).toEqual({ dialect: "mongo", pipeline: [{ $project: { ssn: 0, internal_notes: 0 } }], isAggregate: false });
  });

  it("mysql/postgres cannot push drop_fields (no full column enumeration) — stays residual", () => {
    const plan = compilePushdown("mysql", config);
    expect(plan.dialectQuery).toBeNull();
    expect(plan.pushedDownCount).toBe(0);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms).toEqual(config.steps);
  });
});

describe("compilePushdown — order-stopping semantics", () => {
  it("a non-pushable step blocks every later step from pushing down too, on SQL dialects", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "filter", conditions: [{ field: "age", operator: "gt", value: 18 }] },
        { kind: "drop_fields", fields: ["ssn"] }, // blocks here for mysql/postgres
        { kind: "filter", conditions: [{ field: "name", operator: "eq", value: "Ada" }] },
      ],
    };
    const plan = compilePushdown("mysql", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(2);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["drop_fields", "filter"]);
    expect(plan.dialectQuery).toEqual({
      dialect: "mysql",
      whereSql: "(`age` > ?)",
      selectSql: null,
      params: [18],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
    });
  });

  it("the same config pushes everything down on mongo (no blocking step)", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "filter", conditions: [{ field: "age", operator: "gt", value: 18 }] },
        { kind: "drop_fields", fields: ["ssn"] },
        { kind: "filter", conditions: [{ field: "name", operator: "eq", value: "Ada" }] },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(3);
    expect(plan.residualCount).toBe(0);
  });
});

describe("compilePushdown — injection-shaped identifiers", () => {
  it("escapes a backtick/quote-laden field name instead of breaking out of the identifier", () => {
    const config: TransformConfig = {
      steps: [{ kind: "filter", conditions: [{ field: "a`b\"c", operator: "eq", value: 1 }] }],
    };
    const mysqlPlan = compilePushdown("mysql", config);
    expect(mysqlPlan.dialectQuery).toMatchObject({ whereSql: "(`a``b\"c` = ?)" });

    const pgPlan = compilePushdown("postgres", config);
    expect(pgPlan.dialectQuery).toMatchObject({ whereSql: '("a`b""c" = $1)' });
  });
});

/**
 * Parametrized across both SQL dialects so every aggregate case is proven
 * identically for mysql AND postgres (addendum, docs/decisions.md Block 6):
 * the compiler's dialect axis is ONE generic SQL emitter (compileSql,
 * pushdown.ts) with exactly two dialect-conditional primitives —
 * quoteIdent (backtick vs double-quote) and placeholder (`?` vs `$n`),
 * both mirrored locally here as q()/ph(). Postgres was already a
 * first-class emit target before this addendum (compileSql takes
 * `dialect: SqlDialect = "mysql" | "postgres"`, not a mysql-only type) —
 * this block only systematizes test coverage to full parity, it doesn't
 * add new compiler capability.
 */
describe.each(["mysql", "postgres"] as const)("compilePushdown — aggregate, SQL dialect: %s", (dialect) => {
  it("GROUP BY + MAX(...) AS alias", () => {
    const config: TransformConfig = {
      steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(0);
    expect(plan.dialectQuery).toEqual({
      dialect,
      whereSql: null,
      selectSql: `${q(dialect, "cohort")}, MAX(${q(dialect, "salary")}) AS ${q(dialect, "max_salary")}`,
      params: [],
      isAggregate: true,
      groupBySql: q(dialect, "cohort"),
      havingSql: null,
    });
  });

  it("whole-table aggregate (empty groupBy) has no GROUP BY clause", () => {
    const config: TransformConfig = {
      steps: [{ kind: "aggregate", groupBy: [], aggregations: [{ fn: "count", field: null, alias: "n" }] }],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.dialectQuery).toEqual({
      dialect,
      whereSql: null,
      selectSql: `COUNT(*) AS ${q(dialect, "n")}`,
      params: [],
      isAggregate: true,
      groupBySql: null,
      havingSql: null,
    });
  });

  it("count / count_field / count_distinct compile to distinct SQL forms", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: [],
          aggregations: [
            { fn: "count", field: null, alias: "n_all" },
            { fn: "count_field", field: "email", alias: "n_with_email" },
            { fn: "count_distinct", field: "email", alias: "n_distinct_email" },
          ],
        },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.dialectQuery).toMatchObject({
      selectSql: `COUNT(*) AS ${q(dialect, "n_all")}, COUNT(${q(dialect, "email")}) AS ${q(dialect, "n_with_email")}, COUNT(DISTINCT ${q(dialect, "email")}) AS ${q(dialect, "n_distinct_email")}`,
    });
  });

  it("a filter step ahead of the aggregate pushes down as a pre-aggregate WHERE", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "filter", conditions: [{ field: "age", operator: "gt", value: 18 }] },
        { kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.pushedDownCount).toBe(2);
    expect(plan.dialectQuery).toMatchObject({ whereSql: `(${q(dialect, "age")} > ${ph(dialect, 1)})`, params: [18], isAggregate: true });
  });

  it("having re-embeds the aggregation's bare expression (ruling 2: alias-only reference)", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: [{ field: "max_salary", operator: "gt", value: 100000 }],
        },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.dialectQuery).toMatchObject({ havingSql: `(MAX(${q(dialect, "salary")}) > ${ph(dialect, 1)})`, params: [100000] });
  });

  it("having can also reference a groupBy field (plain quoted column, not re-embedded)", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: [{ field: "cohort", operator: "neq", value: "unassigned" }],
        },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.dialectQuery).toMatchObject({ havingSql: `(${q(dialect, "cohort")} <> ${ph(dialect, 1)})`, params: ["unassigned"] });
  });

  it("a computed_field ahead of the aggregate blocks the aggregate into residual too (v1: no subquery layering)", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "computed_field", name: "adj_salary", expression: expr("salary * 2") },
        { kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "adj_salary", alias: "max_salary" }] },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["aggregate"]);
  });

  it("ruling 1: pushes one aggregate producing sum+count sibling aliases, then computes their ratio residually", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [
            { fn: "sum", field: "amount", alias: "cohort_sum" },
            { fn: "count", field: null, alias: "cohort_count" },
          ],
        },
        { kind: "computed_field", name: "cohort_avg", expression: expr("cohort_sum / cohort_count") },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["computed_field"]);
    expect(plan.dialectQuery).toEqual({
      dialect,
      whereSql: null,
      selectSql: `${q(dialect, "cohort")}, SUM(${q(dialect, "amount")}) AS ${q(dialect, "cohort_sum")}, COUNT(*) AS ${q(dialect, "cohort_count")}`,
      params: [],
      isAggregate: true,
      groupBySql: q(dialect, "cohort"),
      havingSql: null,
    });
  });

  it("ruling 1: structurally chains a second (coarser-grain) Aggregate after a pushed one as residual — multi-level rollup, not pushed twice", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "aggregate", groupBy: ["region", "cohort"], aggregations: [{ fn: "sum", field: "amount", alias: "subtotal" }] },
        { kind: "aggregate", groupBy: ["region"], aggregations: [{ fn: "sum", field: "subtotal", alias: "region_total" }] },
      ],
    };
    const plan = compilePushdown(dialect, config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["aggregate"]);
    expect(plan.dialectQuery).toMatchObject({ isAggregate: true, groupBySql: `${q(dialect, "region")}, ${q(dialect, "cohort")}` });
  });
});

describe("compilePushdown — aggregate, mongo", () => {
  it("groupBy + one accumulator compiles to $group / $addFields / $project", () => {
    const config: TransformConfig = {
      steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
      ],
    });
  });

  it("whole-table aggregate (empty groupBy) groups on _id: null", () => {
    const config: TransformConfig = {
      steps: [{ kind: "aggregate", groupBy: [], aggregations: [{ fn: "count", field: null, alias: "n" }] }],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }, { $addFields: {} }, { $project: { _id: 0 } }],
    });
  });

  it("count_distinct compiles to the $addToSet + $size two-stage pattern", () => {
    const config: TransformConfig = {
      steps: [{ kind: "aggregate", groupBy: [], aggregations: [{ fn: "count_distinct", field: "email", alias: "n" }] }],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: null, __distinct_n: { $addToSet: "$email" } } },
        { $addFields: { n: { $size: "$__distinct_n" } } },
        { $project: { _id: 0, __distinct_n: 0 } },
      ],
    });
  });

  it("having appends a trailing $match against the flattened (post-$project) fields", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: [{ field: "max_salary", operator: "gt", value: 100000 }],
        },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toMatchObject({
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
        { $match: { max_salary: { $gt: 100000 } } },
      ],
    });
  });

  it("having can also reference a groupBy field (post-$project top-level field, not just an alias)", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: [{ field: "cohort", operator: "neq", value: "unassigned" }],
        },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toMatchObject({
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
        { $match: { cohort: { $ne: "unassigned" } } },
      ],
    });
  });

  it("count / count_field / count_distinct together compile to $sum / $cond / $addToSet+$size forms in one $group", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: [],
          aggregations: [
            { fn: "count", field: null, alias: "n_all" },
            { fn: "count_field", field: "email", alias: "n_with_email" },
            { fn: "count_distinct", field: "email", alias: "n_distinct_email" },
          ],
        },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        {
          $group: {
            _id: null,
            n_all: { $sum: 1 },
            n_with_email: { $sum: { $cond: [{ $ne: ["$email", null] }, 1, 0] } },
            __distinct_n_distinct_email: { $addToSet: "$email" },
          },
        },
        { $addFields: { n_distinct_email: { $size: "$__distinct_n_distinct_email" } } },
        { $project: { _id: 0, __distinct_n_distinct_email: 0 } },
      ],
    });
  });

  it("a filter step ahead of the aggregate pushes down as a pre-aggregate $match", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "filter", conditions: [{ field: "age", operator: "gt", value: 18 }] },
        { kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(2);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $match: { age: { $gt: 18 } } },
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
      ],
    });
  });

  it("a computed_field ahead of the aggregate blocks it into residual too — a v1 scope cut that is dialect-independent (splitPushable, pushdown.ts), not SQL-specific: even though mongo's pipeline could structurally support $addFields before $group, the same 'no non-filter step ahead of a pushed aggregate' rule applies uniformly to all 3 dialects", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "computed_field", name: "adj_salary", expression: expr("salary * 2") },
        { kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "adj_salary", alias: "max_salary" }] },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["aggregate"]);
  });

  it("ruling 1: pushes one aggregate producing sum+count sibling aliases, then computes their ratio residually", () => {
    const config: TransformConfig = {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [
            { fn: "sum", field: "amount", alias: "cohort_sum" },
            { fn: "count", field: null, alias: "cohort_count" },
          ],
        },
        { kind: "computed_field", name: "cohort_avg", expression: expr("cohort_sum / cohort_count") },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["computed_field"]);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, cohort_sum: { $sum: "$amount" }, cohort_count: { $sum: 1 } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
      ],
    });
  });

  it("ruling 1: structurally chains a second (coarser-grain) Aggregate after a pushed one as residual — multi-level rollup, not pushed twice", () => {
    const config: TransformConfig = {
      steps: [
        { kind: "aggregate", groupBy: ["region", "cohort"], aggregations: [{ fn: "sum", field: "amount", alias: "subtotal" }] },
        { kind: "aggregate", groupBy: ["region"], aggregations: [{ fn: "sum", field: "subtotal", alias: "region_total" }] },
      ],
    };
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(1);
    expect(plan.residualTransforms.map((s) => s.kind)).toEqual(["aggregate"]);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { region: "$region", cohort: "$cohort" }, subtotal: { $sum: "$amount" } } },
        { $addFields: { region: "$_id.region", cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
      ],
    });
  });
});

/**
 * Ruling 1 (docs/decisions.md, Block 6 approval): %-of-total stays a
 * composition, not a first-class fn — proven here via a real, valid
 * composition: a pushed fine-grain Aggregate producing two sibling output
 * aliases on the same row (sum + count), followed by a residual
 * computed_field dividing those two aggregate-output aliases (-> per-cohort
 * average). This is the composition pattern the chaining contract actually
 * supports without a join/window primitive. The mysql/postgres cases for
 * this composition (and the multi-level-rollup case below) now live in the
 * describe.each block above, parametrized across both SQL dialects; the
 * mongo-side equivalents live at the end of the "aggregate, mongo" block
 * above. This comment stays here as the ruling's canonical writeup.
 *
 * Disclosed finding (see the Stage 2 report): literal broadcast-style
 * %-of-total — a row's value divided by a GRAND TOTAL visible on every row,
 * e.g. "this cohort's share of the whole table" — is NOT provably
 * expressible under the current linear TransformStep chaining model.
 * AggregateStep is reduce-only (no window/partition broadcast mode), and
 * there is no join primitive to recombine a coarser-grain aggregate's single
 * output row back onto every row of a finer-grain aggregate's output. Per
 * the ruling's own contingency, no window/join primitive was built to force
 * this — %_of_total remains parked as a composition, and the gap is
 * disclosed rather than silently promoted to first-class.
 */
