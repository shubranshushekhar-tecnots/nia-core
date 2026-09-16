import { describe, expect, it } from "vitest";
import { compilePushdown, manifestDialect } from "./pushdown.js";
import type { TransformConfig } from "./nodeConfig.js";
import { parseExpression } from "./expression.js";

function expr(src: string) {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
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
    });
  });

  it("postgres: double-quoted identifiers, $n placeholders", () => {
    const plan = compilePushdown("postgres", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "postgres",
      whereSql: '("age" > $1) AND ("name" = $2)',
      selectSql: null,
      params: [30, "Ada"],
    });
  });

  it("mongo: $match with $and of per-condition operators", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $match: { $and: [{ age: { $gt: 30 } }, { name: { $eq: "Ada" } }] } }],
    });
  });

  it("contains -> LIKE %..% (sql) / escaped $regex (mongo)", () => {
    const containsConfig: TransformConfig = { steps: [{ kind: "filter", conditions: [{ field: "email", operator: "contains", value: "a.b+c" }] }] };
    const mysqlPlan = compilePushdown("mysql", containsConfig);
    expect(mysqlPlan.dialectQuery).toEqual({ dialect: "mysql", whereSql: "(`email` LIKE ?)", selectSql: null, params: ["%a.b+c%"] });

    const mongoPlan = compilePushdown("mongo", containsConfig);
    expect(mongoPlan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $match: { email: { $regex: "a\\.b\\+c", $options: "i" } } }],
    });
  });

  it("is_null / is_not_null carry no param", () => {
    const config2: TransformConfig = { steps: [{ kind: "filter", conditions: [{ field: "deleted_at", operator: "is_null" }] }] };
    const plan = compilePushdown("postgres", config2);
    expect(plan.dialectQuery).toEqual({ dialect: "postgres", whereSql: '("deleted_at" IS NULL)', selectSql: null, params: [] });
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
    });
  });

  it("mongo: $addFields with $concat", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $addFields: { full_name: { $concat: ["$first", " ", "$last"] } } }],
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
    });
    const mongo = compilePushdown("mongo", nested);
    expect(mongo.dialectQuery).toEqual({
      dialect: "mongo",
      pipeline: [{ $addFields: { total: { $multiply: [{ $ifNull: ["$price", 0] }, "$qty"] } } }],
    });
  });
});

describe("compilePushdown — drop_fields asymmetry (mongo pushable, SQL residual)", () => {
  const config: TransformConfig = { steps: [{ kind: "drop_fields", fields: ["ssn", "internal_notes"] }] };

  it("mongo pushes drop_fields down as a $project exclusion", () => {
    const plan = compilePushdown("mongo", config);
    expect(plan.pushedDownCount).toBe(1);
    expect(plan.residualCount).toBe(0);
    expect(plan.dialectQuery).toEqual({ dialect: "mongo", pipeline: [{ $project: { ssn: 0, internal_notes: 0 } }] });
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
    expect(plan.dialectQuery).toEqual({ dialect: "mysql", whereSql: "(`age` > ?)", selectSql: null, params: [18] });
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
