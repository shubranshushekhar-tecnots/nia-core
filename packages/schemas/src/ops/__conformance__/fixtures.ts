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
 * Phase 8b (see docs/decisions.md) will reuse this same array, adding a
 * DB-execution assertion per fixture instead of duplicating fixture
 * authoring.
 */
export interface OpFixture {
  opKind: OpKind;
  dialect: SourceDialect;
  description: string;
  config: TransformConfig;
  expectedDialectQuery: DialectQuery;
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
      whereSql: "(`age` > ?) AND (`name` = ?)",
      selectSql: null,
      params: [30, "Ada"],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
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
      selectSql: "(CASE WHEN (`status` = ?) THEN ? ELSE ? END) AS `status_flag`",
      params: ["active", 1, 0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
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
      selectSql: '(CASE WHEN ("status" = $1) THEN $2 ELSE $3 END) AS "status_flag"',
      params: ["active", 1, 0],
      isAggregate: false,
      groupBySql: null,
      havingSql: null,
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
      selectSql: "`cohort`, MAX(`salary`) AS `max_salary`",
      params: [],
      isAggregate: true,
      groupBySql: "`cohort`",
      havingSql: null,
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
      selectSql: "`cohort`, MAX(`salary`) AS `max_salary`",
      params: [100000],
      isAggregate: true,
      groupBySql: "`cohort`",
      havingSql: "(MAX(`salary`) > ?)",
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
      ],
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
      selectSql: "`cohort`, MAX(`salary`) AS `max_salary`",
      params: ["unassigned"],
      isAggregate: true,
      groupBySql: "`cohort`",
      havingSql: "(`cohort` <> ?)",
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
      ],
    },
  },
];
