import { parseExpression } from "../../expression.js";
import type { TransformConfig } from "../../nodeConfig.js";
import type { DialectQuery, SourceDialect } from "../../pushdown.js";
import type { OpKind } from "../types.js";

function expr(src: string) {
  const parsed = parseExpression(src);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expr;
}

/**
 * One fixture = one single-step TransformConfig for a given op, compiled
 * against a given dialect via the real `compilePushdown` (pushdown.ts),
 * asserted against an exact expected `dialectQuery` shape. Ported (as
 * data, not reimplemented assertions) from pushdown.test.ts's existing
 * per-dialect cases — that file stays in place, unchanged, as the
 * existing coverage of compilePushdown's public behavior; these fixtures
 * exist so ops.conformance.test.ts can iterate OP_REGISTRY generically
 * and fail by omission if a future op ships with no fixture for a
 * dialect it claims to support (isPushable === true).
 *
 * Phase 8b-2a (see docs/decisions.md) reuses this same array for
 * DB-execution assertions via the optional `dbCase` field below, rather
 * than duplicating fixture authoring in a parallel array.
 */
export interface OpFixture {
  opKind: OpKind;
  dialect: SourceDialect;
  description: string;
  config: TransformConfig;
  expectedDialectQuery: DialectQuery;
  /**
   * Optional: when present, `apps/worker/scripts/ops-db-conformance.ts`
   * seeds these rows into a scratch table/collection (via
   * `apps/worker/scripts/lib/dbHarness.ts`), runs `config` compiled for
   * `dialect` through the real dispatch path, and asserts the returned
   * rows equal `expectedRows` (order-independent; the harness's own
   * `id`/`_id` key column is stripped before comparison — never include
   * it here). Absent for fixtures where DB-execution coverage doesn't add
   * proof value beyond the shape assertion.
   */
  dbCase?: { seedRows: Record<string, unknown>[]; expectedRows: Record<string, unknown>[] };
  /**
   * Optional: marks a `dbCase` as a known, already-tracked failure rather
   * than an untriaged one. `ops-db-conformance.ts` reports it as XFAIL
   * (doesn't count toward the run's pass/fail exit code) if it still
   * fails, or XPASS (informational only, still doesn't fail the run) if
   * it unexpectedly starts passing — a genuinely NEW failure on any other
   * fixture still fails the run immediately. Keep this list short: it's
   * for a specific, already-diagnosed, already-scheduled bug (see
   * `decisionsRef`), never a way to silence an untriaged flake.
   */
  knownFailure?: { reason: string; decisionsRef: string };
}

export const OP_FIXTURES: OpFixture[] = [
  // ---- filter --------------------------------------------------------
  {
    opKind: "filter",
    dialect: "mysql",
    description: "two AND-combined conditions, backtick identifiers, ? placeholders",
    config: { steps: [{ kind: "filter", expr: expr('age > 30 and name = "Ada"') }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: "(`age` > ?) AND (`name` = BINARY ?)",
      selectSql: null,
      params: [30, "Ada"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Ada" },
        { age: 40, name: "Bob" },
        { age: 45, name: "Ada" },
      ],
      expectedRows: [
        { age: 35, name: "Ada" },
        { age: 45, name: "Ada" },
      ],
    },
  },
  {
    opKind: "filter",
    dialect: "postgres",
    description: "two AND-combined conditions, double-quoted identifiers, $n placeholders",
    config: { steps: [{ kind: "filter", expr: expr('age > 30 and name = "Ada"') }] },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: '("age" > $1) AND ("name" = $2)',
      selectSql: null,
      params: [30, "Ada"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Ada" },
        { age: 40, name: "Bob" },
        { age: 45, name: "Ada" },
      ],
      expectedRows: [
        { age: 35, name: "Ada" },
        { age: 45, name: "Ada" },
      ],
    },
  },
  {
    opKind: "filter",
    dialect: "mongo",
    description: "$match with $and of per-condition operators",
    config: { steps: [{ kind: "filter", expr: expr('age > 30 and name = "Ada"') }] },
    expectedDialectQuery: {
      dialect: "mongo",
      pipeline: [{ $match: { $and: [{ age: { $gt: 30 } }, { name: { $eq: "Ada" } }] } }],
      isAggregate: false,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Ada" },
        { age: 40, name: "Bob" },
        { age: 45, name: "Ada" },
      ],
      expectedRows: [
        { age: 35, name: "Ada" },
        { age: 45, name: "Ada" },
      ],
    },
  },
  {
    opKind: "filter",
    dialect: "mysql",
    description: "single comparison node (no logical wrapper), backtick identifier, ? placeholder",
    config: { steps: [{ kind: "filter", expr: expr("age > 30") }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: "(`age` > ?)",
      selectSql: null,
      params: [30],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Bob" },
        { age: 30, name: "Cid" },
      ],
      expectedRows: [{ age: 35, name: "Bob" }],
    },
  },
  {
    opKind: "filter",
    dialect: "postgres",
    description: "single comparison node (no logical wrapper), double-quoted identifier, $n placeholder",
    config: { steps: [{ kind: "filter", expr: expr("age > 30") }] },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: '("age" > $1)',
      selectSql: null,
      params: [30],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Bob" },
        { age: 30, name: "Cid" },
      ],
      expectedRows: [{ age: 35, name: "Bob" }],
    },
  },
  {
    opKind: "filter",
    dialect: "mongo",
    description: "$match with a single $expr comparison operator, no $and wrapper",
    config: { steps: [{ kind: "filter", expr: expr("age > 30") }] },
    expectedDialectQuery: {
      dialect: "mongo",
      pipeline: [{ $match: { age: { $gt: 30 } } }],
      isAggregate: false,
    },
    dbCase: {
      seedRows: [
        { age: 25, name: "Ada" },
        { age: 35, name: "Bob" },
        { age: 30, name: "Cid" },
      ],
      expectedRows: [{ age: 35, name: "Bob" }],
    },
  },

  // ---- computed_field --------------------------------------------------
  {
    opKind: "computed_field",
    dialect: "mysql",
    description: "CONCAT(...) AS alias, string literal parameterized",
    config: { steps: [{ kind: "computed_field", name: "full_name", expression: expr('concat(first, " ", last)') }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql: "CONCAT(`first`, ?, `last`) AS `full_name`",
      params: [" "],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { first: "Ada", last: "Lovelace" },
        { first: "Alan", last: "Turing" },
      ],
      expectedRows: [
        { first: "Ada", last: "Lovelace", full_name: "Ada Lovelace" },
        { first: "Alan", last: "Turing", full_name: "Alan Turing" },
      ],
    },
  },
  {
    opKind: "computed_field",
    dialect: "postgres",
    description: "coalesce + arithmetic nesting",
    config: { steps: [{ kind: "computed_field", name: "total", expression: expr("coalesce(price, 0) * qty") }] },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: null,
      selectSql: '(COALESCE("price", $1) * "qty") AS "total"',
      params: [0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { price: 10, qty: 3 },
        { price: null, qty: 5 },
      ],
      expectedRows: [
        { price: 10, qty: 3, total: 30 },
        { price: null, qty: 5, total: 0 },
      ],
    },
  },
  {
    opKind: "computed_field",
    dialect: "mongo",
    description: "$addFields with $concat",
    config: { steps: [{ kind: "computed_field", name: "full_name", expression: expr('concat(first, " ", last)') }] },
    expectedDialectQuery: {
      dialect: "mongo",
      pipeline: [{ $addFields: { full_name: { $concat: ["$first", " ", "$last"] } } }],
      isAggregate: false,
    },
    dbCase: {
      seedRows: [
        { first: "Ada", last: "Lovelace" },
        { first: "Alan", last: "Turing" },
      ],
      expectedRows: [
        { first: "Ada", last: "Lovelace", full_name: "Ada Lovelace" },
        { first: "Alan", last: "Turing", full_name: "Alan Turing" },
      ],
    },
  },
  {
    opKind: "computed_field",
    dialect: "mysql",
    description: "conditional node -> parenthesized CASE WHEN...ELSE...END AS alias",
    config: {
      steps: [{ kind: "computed_field", name: "status_flag", expression: expr('if(status = "active", 1, 0)') }],
    },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql: "(CASE WHEN (`status` = BINARY ?) THEN ? ELSE ? END) AS `status_flag`",
      params: ["active", 1, 0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [{ status: "active" }, { status: "inactive" }],
      expectedRows: [
        { status: "active", status_flag: 1 },
        { status: "inactive", status_flag: 0 },
      ],
    },
  },
  {
    opKind: "computed_field",
    dialect: "postgres",
    description: "conditional node -> parenthesized CASE WHEN...ELSE...END AS alias",
    config: {
      steps: [{ kind: "computed_field", name: "status_flag", expression: expr('if(status = "active", 1, 0)') }],
    },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: null,
      selectSql:
        '(CASE WHEN ("status" = $1) THEN CAST($2 AS numeric) ELSE CAST($3 AS numeric) END) AS "status_flag"',
      params: ["active", 1, 0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [{ status: "active" }, { status: "inactive" }],
      expectedRows: [
        { status: "active", status_flag: 1 },
        { status: "inactive", status_flag: 0 },
      ],
    },
  },
  {
    opKind: "computed_field",
    dialect: "mongo",
    description: "conditional node -> $addFields with $switch",
    config: {
      steps: [{ kind: "computed_field", name: "status_flag", expression: expr('if(status = "active", 1, 0)') }],
    },
    expectedDialectQuery: {
      dialect: "mongo",
      pipeline: [
        {
          $addFields: {
            status_flag: { $switch: { branches: [{ case: { $eq: ["$status", "active"] }, then: 1 }], default: 0 } },
          },
        },
      ],
      isAggregate: false,
    },
    dbCase: {
      seedRows: [{ status: "active" }, { status: "inactive" }],
      expectedRows: [
        { status: "active", status_flag: 1 },
        { status: "inactive", status_flag: 0 },
      ],
    },
  },

  // ---- drop_fields (mongo-only pushable) --------------------------------
  {
    opKind: "drop_fields",
    dialect: "mongo",
    description: "pushes down as a $project exclusion",
    config: { steps: [{ kind: "drop_fields", fields: ["ssn", "internal_notes"] }] },
    expectedDialectQuery: {
      dialect: "mongo",
      pipeline: [{ $project: { ssn: 0, internal_notes: 0 } }],
      isAggregate: false,
    },
    dbCase: {
      seedRows: [{ name: "Ada", ssn: "111-11-1111", internal_notes: "vip" }],
      expectedRows: [{ name: "Ada" }],
    },
  },

  // ---- aggregate ---------------------------------------------------------
  {
    opKind: "aggregate",
    dialect: "mysql",
    description: "GROUP BY + MAX(...) AS alias",
    config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql: "ANY_VALUE(`cohort`) AS `cohort`, MAX(`salary`) AS `max_salary`, ANY_VALUE(HEX(BINARY `cohort`)) AS `__nia_group_cursor_0`",
      params: [],
      isAggregate: true,
      groupBySql: "BINARY `cohort`",
      havingSql: null,
      orderBySql: "BINARY `cohort`",
      groupCursorColumns: ["__nia_group_cursor_0"],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "eng", salary: 150 },
        { cohort: "sales", salary: 90 },
      ],
      expectedRows: [
        { cohort: "eng", max_salary: 150 },
        { cohort: "sales", max_salary: 90 },
      ],
    },
  },
  {
    opKind: "aggregate",
    dialect: "postgres",
    description: "GROUP BY + MAX(...) AS alias",
    config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }] },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: null,
      selectSql: '"cohort", MAX("salary") AS "max_salary"',
      params: [],
      isAggregate: true,
      groupBySql: '"cohort"',
      havingSql: null,
      orderBySql: '"cohort" NULLS FIRST',
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "eng", salary: 150 },
        { cohort: "sales", salary: 90 },
      ],
      expectedRows: [
        { cohort: "eng", max_salary: 150 },
        { cohort: "sales", max_salary: 90 },
      ],
    },
  },
  {
    opKind: "aggregate",
    dialect: "mongo",
    description: "groupBy + one accumulator compiles to $group / $addFields / $project",
    config: { steps: [{ kind: "aggregate", groupBy: ["cohort"], aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }] }] },
    expectedDialectQuery: {
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
        { $sort: { cohort: 1 } },
      ],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "eng", salary: 150 },
        { cohort: "sales", salary: 90 },
      ],
      expectedRows: [
        { cohort: "eng", max_salary: 150 },
        { cohort: "sales", max_salary: 90 },
      ],
    },
  },

  // ---- aggregate having (ruling 2: alias reference vs. groupBy field) ----
  {
    opKind: "aggregate",
    dialect: "mysql",
    description: "having re-embeds the aggregation's bare accumulator expression (alias-only reference)",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr("max_salary > 100000"),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql:
        "ANY_VALUE(`cohort`) AS `cohort`, MAX(`salary`) AS `max_salary`, ANY_VALUE(HEX(BINARY `cohort`)) AS `__nia_group_cursor_0`",
      params: [100000],
      isAggregate: true,
      groupBySql: "BINARY `cohort`",
      havingSql: "(MAX(`salary`) > ?)",
      orderBySql: "BINARY `cohort`",
      groupCursorColumns: ["__nia_group_cursor_0"],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 120000 },
        { cohort: "eng", salary: 90000 },
        { cohort: "sales", salary: 80000 },
        { cohort: "sales", salary: 95000 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 120000 }],
    },
  },
  {
    opKind: "aggregate",
    dialect: "postgres",
    description: "having re-embeds the aggregation's bare accumulator expression (alias-only reference)",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr("max_salary > 100000"),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: null,
      selectSql: '"cohort", MAX("salary") AS "max_salary"',
      params: [100000],
      isAggregate: true,
      groupBySql: '"cohort"',
      havingSql: '(MAX("salary") > $1)',
      orderBySql: '"cohort" NULLS FIRST',
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 120000 },
        { cohort: "eng", salary: 90000 },
        { cohort: "sales", salary: 80000 },
        { cohort: "sales", salary: 95000 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 120000 }],
    },
  },
  {
    opKind: "aggregate",
    dialect: "mongo",
    description: "having appends a trailing $match against the flattened (post-$project) alias field",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr("max_salary > 100000"),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
        { $match: { max_salary: { $gt: 100000 } } },
        { $sort: { cohort: 1 } },
      ],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 120000 },
        { cohort: "eng", salary: 90000 },
        { cohort: "sales", salary: 80000 },
        { cohort: "sales", salary: 95000 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 120000 }],
    },
  },
  {
    opKind: "aggregate",
    dialect: "mysql",
    description: "having can also reference a groupBy field (plain quoted column, not re-embedded)",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr('cohort != "unassigned"'),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql:
        "ANY_VALUE(`cohort`) AS `cohort`, MAX(`salary`) AS `max_salary`, ANY_VALUE(HEX(BINARY `cohort`)) AS `__nia_group_cursor_0`",
      params: ["unassigned"],
      isAggregate: true,
      groupBySql: "BINARY `cohort`",
      havingSql: "(`cohort` <> BINARY ?)",
      orderBySql: "BINARY `cohort`",
      groupCursorColumns: ["__nia_group_cursor_0"],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "unassigned", salary: 50 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 100 }],
    },
  },
  {
    opKind: "aggregate",
    dialect: "postgres",
    description: "having can also reference a groupBy field (plain quoted column, not re-embedded)",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr('cohort != "unassigned"'),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql: null,
      selectSql: '"cohort", MAX("salary") AS "max_salary"',
      params: ["unassigned"],
      isAggregate: true,
      groupBySql: '"cohort"',
      havingSql: '("cohort" <> $1)',
      orderBySql: '"cohort" NULLS FIRST',
      groupCursorColumns: null,
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "unassigned", salary: 50 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 100 }],
    },
  },
  {
    opKind: "aggregate",
    dialect: "mongo",
    description: "having can also reference a groupBy field (post-$project top-level field, not just an alias)",
    config: {
      steps: [
        {
          kind: "aggregate",
          groupBy: ["cohort"],
          aggregations: [{ fn: "max", field: "salary", alias: "max_salary" }],
          having: expr('cohort != "unassigned"'),
        },
      ],
    },
    expectedDialectQuery: {
      dialect: "mongo",
      isAggregate: true,
      pipeline: [
        { $group: { _id: { cohort: "$cohort" }, max_salary: { $max: "$salary" } } },
        { $addFields: { cohort: "$_id.cohort" } },
        { $project: { _id: 0 } },
        { $match: { cohort: { $ne: "unassigned" } } },
        { $sort: { cohort: 1 } },
      ],
    },
    dbCase: {
      seedRows: [
        { cohort: "eng", salary: 100 },
        { cohort: "unassigned", salary: 50 },
      ],
      expectedRows: [{ cohort: "eng", max_salary: 100 }],
    },
  },

  // ---- Phase 8b-3 onFailure — shape-only (DB-execution proof already
  // lives in apps/worker/scripts/lib/agreementCases.ts's `tag: "onfailure"`
  // cases, run live against real infra; these fixtures exist only to
  // pin the *compiled query shape* the way every other fixture in this
  // file does, and to fail by omission if onFailure's pushdown shape ever
  // regresses). No `dbCase` on any of these — see docs/decisions.md's
  // "Phase 8b-3" entry for why: `'fail'`/`'quarantine'` never produce a
  // DialectQuery at all (fallibleStepIsPushable forces them fully
  // residual), so only `'null'`/`'drop'` are representable here.
  {
    opKind: "computed_field",
    dialect: "mysql",
    description: "onFailure: 'null' pushes with zero extra shape — the fallible expression is the whole SELECT, no added WHERE",
    config: { steps: [{ kind: "computed_field", name: "y", expression: expr("to_boolean(x)"), onFailure: "null" }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql: null,
      selectSql:
        "(CASE WHEN `x` IS NULL THEN NULL WHEN (`x` IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(`x`), '$[0]')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')) THEN (CASE WHEN CAST(`x` AS DOUBLE) = 1 THEN TRUE WHEN CAST(`x` AS DOUBLE) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('true', '1') THEN TRUE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('false', '0') THEN FALSE ELSE NULL END) END) AS `y`",
      params: [],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
  },
  {
    opKind: "computed_field",
    dialect: "mysql",
    description: "onFailure: 'drop' adds an explicit 'WHERE NOT <failure predicate>' stage — computed_field's SELECT-only shape doesn't naturally exclude a failing row the way filter's WHERE does",
    config: { steps: [{ kind: "computed_field", name: "y", expression: expr("to_boolean(x)"), onFailure: "drop" }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql:
        "(NOT (((CASE WHEN `x` IS NULL THEN NULL WHEN (`x` IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(`x`), '$[0]')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')) THEN (CASE WHEN CAST(`x` AS DOUBLE) = 1 THEN TRUE WHEN CAST(`x` AS DOUBLE) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('true', '1') THEN TRUE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('false', '0') THEN FALSE ELSE NULL END) END) IS NULL AND `x` IS NOT NULL)))",
      selectSql:
        "(CASE WHEN `x` IS NULL THEN NULL WHEN (`x` IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(`x`), '$[0]')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')) THEN (CASE WHEN CAST(`x` AS DOUBLE) = 1 THEN TRUE WHEN CAST(`x` AS DOUBLE) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('true', '1') THEN TRUE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('false', '0') THEN FALSE ELSE NULL END) END) AS `y`",
      params: [],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
  },
  {
    opKind: "computed_field",
    dialect: "postgres",
    description: "onFailure: 'drop' adds the same 'WHERE NOT <failure predicate>' stage on postgres",
    config: { steps: [{ kind: "computed_field", name: "y", expression: expr("to_boolean(x)"), onFailure: "drop" }] },
    expectedDialectQuery: {
      dialect: "postgres",
      whereSql:
        '(NOT (((CASE WHEN "x" IS NULL THEN NULL WHEN ("x" IS NOT NULL AND CAST(pg_typeof("x") AS text) IN (\'smallint\', \'integer\', \'bigint\', \'decimal\', \'numeric\', \'real\', \'double precision\')) THEN (CASE WHEN CAST("x" AS double precision) = 1 THEN TRUE WHEN CAST("x" AS double precision) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST("x" AS text))) IN (\'true\', \'1\') THEN TRUE WHEN TRIM(LOWER(CAST("x" AS text))) IN (\'false\', \'0\') THEN FALSE ELSE NULL END) END) IS NULL AND "x" IS NOT NULL)))',
      selectSql:
        '(CASE WHEN "x" IS NULL THEN NULL WHEN ("x" IS NOT NULL AND CAST(pg_typeof("x") AS text) IN (\'smallint\', \'integer\', \'bigint\', \'decimal\', \'numeric\', \'real\', \'double precision\')) THEN (CASE WHEN CAST("x" AS double precision) = 1 THEN TRUE WHEN CAST("x" AS double precision) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST("x" AS text))) IN (\'true\', \'1\') THEN TRUE WHEN TRIM(LOWER(CAST("x" AS text))) IN (\'false\', \'0\') THEN FALSE ELSE NULL END) END) AS "y"',
      params: [],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
  },
  {
    opKind: "computed_field",
    dialect: "mongo",
    description: "onFailure: 'drop' appends a trailing $match/$not stage after $addFields, mirroring the SQL 'WHERE NOT' shape",
    config: { steps: [{ kind: "computed_field", name: "y", expression: expr("to_boolean(x)"), onFailure: "drop" }] },
    expectedDialectQuery: {
      dialect: "mongo",
      isAggregate: false,
      pipeline: [
        {
          $addFields: {
            y: {
              $cond: [
                { $eq: ["$x", null] },
                null,
                {
                  $cond: [
                    { $isNumber: "$x" },
                    { $cond: [{ $eq: ["$x", 1] }, true, { $cond: [{ $eq: ["$x", 0] }, false, null] }] },
                    {
                      $cond: [
                        { $in: [{ $trim: { input: { $toLower: { $toString: "$x" } } } }, ["true", "1"]] },
                        true,
                        { $cond: [{ $in: [{ $trim: { input: { $toLower: { $toString: "$x" } } } }, ["false", "0"]] }, false, null] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          $match: {
            $expr: {
              $not: [
                {
                  $and: [
                    {
                      $eq: [
                        {
                          $cond: [
                            { $eq: ["$x", null] },
                            null,
                            {
                              $cond: [
                                { $isNumber: "$x" },
                                { $cond: [{ $eq: ["$x", 1] }, true, { $cond: [{ $eq: ["$x", 0] }, false, null] }] },
                                {
                                  $cond: [
                                    { $in: [{ $trim: { input: { $toLower: { $toString: "$x" } } } }, ["true", "1"]] },
                                    true,
                                    {
                                      $cond: [
                                        { $in: [{ $trim: { input: { $toLower: { $toString: "$x" } } } }, ["false", "0"]] },
                                        false,
                                        null,
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                        null,
                      ],
                    },
                    { $ne: ["$x", null] },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
  },
  {
    opKind: "filter",
    dialect: "mysql",
    description: "onFailure: 'null' on a filter pushes as a plain WHERE — no extra stage, since a fallible call's NULL result already excludes the row under three-valued logic",
    config: { steps: [{ kind: "filter", expr: expr("to_boolean(x) = true"), onFailure: "null" }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql:
        "(((CASE WHEN `x` IS NULL THEN NULL WHEN (`x` IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(`x`), '$[0]')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')) THEN (CASE WHEN CAST(`x` AS DOUBLE) = 1 THEN TRUE WHEN CAST(`x` AS DOUBLE) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('true', '1') THEN TRUE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('false', '0') THEN FALSE ELSE NULL END) END) = ?))",
      selectSql: null,
      params: [true],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
  },
  {
    opKind: "filter",
    dialect: "mysql",
    description: "onFailure: 'drop' on a filter compiles byte-identical WHERE SQL to 'null' above — proves the documented null≡drop collapse for filter (nodeConfig.ts's OnFailurePolicy doc comment) holds at the pushed-SQL level too, not just residually",
    config: { steps: [{ kind: "filter", expr: expr("to_boolean(x) = true"), onFailure: "drop" }] },
    expectedDialectQuery: {
      dialect: "mysql",
      whereSql:
        "(((CASE WHEN `x` IS NULL THEN NULL WHEN (`x` IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(`x`), '$[0]')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')) THEN (CASE WHEN CAST(`x` AS DOUBLE) = 1 THEN TRUE WHEN CAST(`x` AS DOUBLE) = 0 THEN FALSE ELSE NULL END) ELSE (CASE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('true', '1') THEN TRUE WHEN TRIM(LOWER(CAST(`x` AS CHAR))) IN ('false', '0') THEN FALSE ELSE NULL END) END) = ?))",
      selectSql: null,
      params: [true],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
      orderBySql: null,
      groupCursorColumns: null,
    },
  },
];
