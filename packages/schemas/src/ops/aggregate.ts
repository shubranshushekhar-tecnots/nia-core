import { AggregateStep, type AggregateStep as AggregateStepT, type AggregationSpec, exprToConditions } from "../nodeConfig.js";
import { collectFieldRefs, type Expr } from "../expression.js";
import type { OpKind, OpModule, ResidualAccumulator, SqlEmitContext } from "./types.js";
import { exprFnsPushable } from "./types.js";
import { evalExpr } from "./residualEval.js";
import { computeFailureReport, fallibleStepIsPushable, resolveOnFailure } from "./onFailure.js";

/**
 * Phase 9 Part 1: the cross-chunk accumulator backing aggregateOp's
 * `residualExecution: "stateful"` contract. `feed` may be called once per
 * fetched chunk — group state (`groups`) lives in this closure, not in
 * `applyResidual`'s call stack, so multiple `feed` calls correctly combine
 * into one running total per group instead of each starting fresh (the
 * exact bug this accumulator replaces: see runEtl.ts and ResidualAccumulator's
 * doc comment in types.ts). `applyResidual` itself is unchanged in
 * behavior — it still builds a fresh accumulator, feeds it the entire
 * input in one call, and finalizes immediately — so every existing
 * complete-dataset caller (ops-agreement.ts, residualTransform.test.ts,
 * collation-probe.ts) is unaffected.
 */
function createAggregateAccumulator(step: AggregateStepT): ResidualAccumulator {
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

  function feed(rows: Record<string, unknown>[]): void {
    for (const row of rows) {
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
  }

  function finalize(): { cols: string[]; rows: Record<string, unknown>[]; failures?: import("./types.js").StepFailureReport[] } {
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
    // field — both are now plain top-level keys on outRow, so evalExpr (the
    // same helper filter steps use) applies directly, no special-casing.
    // Phase 8b-3: failures counted BEFORE the having-filter below removes
    // any rows — the equivalent point to where the SQL/Mongo flag column
    // exists (part of the same select/group HAVING filters, not excluded
    // by it).
    const report = step.having
      ? computeFailureReport("aggregate having", step.having, outRows, resolveOnFailure(step.onFailure))
      : undefined;
    if (step.having) {
      outRows = outRows.filter((row) => evalExpr(step.having!, row) === true);
    }

    return { cols, rows: outRows, failures: report ? [report] : undefined };
  }

  return { feed, size: () => groups.size, finalize };
}

/**
 * SQL HAVING can't portably reference a SELECT alias across mysql/postgres
 * (compileConditionAgainstTarget's existing doc comment), so an
 * alias-referencing `field` node inside `having` must be re-embedded as the
 * aggregation's own accumulator SQL (e.g. `max_salary` -> `MAX(salary)`)
 * rather than compiled as a plain quoted identifier. compileExpr has no
 * notion of that substitution — it only knows plain field -> quoteIdent —
 * so for the rare having shape exprToConditions can't flatten (an `or`/
 * `not`/nested `conditional`, never produced by the editor, only by
 * hand-authored/Copilot JSON), this walks `expr`, swaps every alias-
 * matching field for a synthesized placeholder field name, compiles the
 * substituted tree through the adapter's ordinary compileExpr (so operator
 * precedence and $n/? param numbering are handled identically to any other
 * Expr), then string-replaces each placeholder's quoted-identifier
 * occurrence with the real accumulator SQL. Placeholder names are
 * synthesized locally (never derived from user input), so this is not an
 * injection risk. The common flat-AND-of-comparisons case (everything the
 * having editor and legacy data ever produce) never reaches this function —
 * it stays on the original compileConditionAgainstTarget path below,
 * byte-identical with pre-8b-1 output.
 */
function compileHavingViaSubstitution(expr: Expr, ctx: SqlEmitContext, aggregations: AggregationSpec[]): string {
  const accumulatorForPlaceholder = new Map<string, string>();
  let counter = 0;

  function substitute(node: Expr): Expr {
    if (node.kind === "field") {
      const agg = aggregations.find((a) => a.alias === node.name);
      if (!agg) return node;
      const placeholderName = `__having_alias_${counter++}__`;
      accumulatorForPlaceholder.set(ctx.adapter.quoteIdent(placeholderName), ctx.adapter.compileAggAccumulator(agg));
      return { kind: "field", name: placeholderName };
    }
    switch (node.kind) {
      case "literal":
        return node;
      case "binary":
        return { ...node, left: substitute(node.left), right: substitute(node.right) };
      case "call":
        return { ...node, args: node.args.map(substitute) };
      case "comparison":
        return { ...node, left: substitute(node.left), right: substitute(node.right) };
      case "logical":
        return { ...node, args: node.args.map(substitute) };
      case "conditional":
        return {
          ...node,
          branches: node.branches.map((b) => ({ when: substitute(b.when), then: substitute(b.then) })),
          else: substitute(node.else),
        };
    }
  }

  const substituted = substitute(expr);
  let sql = ctx.adapter.compileExpr(substituted, ctx.params);
  for (const [quotedPlaceholder, accumulatorSql] of accumulatorForPlaceholder) {
    sql = sql.split(quotedPlaceholder).join(accumulatorSql);
  }
  return sql;
}

export const aggregateOp: OpModule<AggregateStepT> = {
  kind: "aggregate",
  schema: AggregateStep,
  residualExecution: "stateful",

  createDefault(): AggregateStepT {
    return { kind: "aggregate", groupBy: [], aggregations: [] };
  },

  isPushable(dialect, step) {
    // GROUP BY / $group exist in all 3 dialects — always structurally
    // pushable regardless of groupBy/aggregations content.
    // pushdownPrefixRequirement/blocksFollowingPushdown below constrain
    // WHERE an aggregate step may land in the pushed list, for reasons
    // that have nothing to do with dialect support. `having`, if present,
    // is the only Expr content this op carries — it may reference a
    // call-fn that isn't pushable on `dialect`.
    //
    // Phase 8b-3: a fallible call inside `having` already excludes the
    // group under three-valued logic (same null≡drop collapse as
    // filter), so "null"/"drop" push normally with zero extra code.
    // "fail" pushes too (Phase 9 Part 4, via pushdown.ts's
    // compileFailurePreChecks — a synthetic pre-check with the same
    // `having` alias-substitution this step's own emitSql/emitMongo use,
    // replaced with the failure predicate, counting failing GROUPS). Only
    // "quarantine" is still always forced residual (fallibleStepIsPushable)
    // — only residual execution has the source row the quarantine sink
    // (Phase 11) needs.
    if (step.having && !fallibleStepIsPushable(step, step.having)) return false;
    return step.having ? exprFnsPushable(step.having, dialect) : true;
  },

  pushdownPrefixRequirement(pushedKindsSoFar: OpKind[]) {
    // An aggregate step may only be preceded, within the pushed prefix, by
    // `filter` steps — a pushed computed_field/drop_fields ahead of it
    // would require referencing a computed/projected column inside its own
    // GROUP BY/SELECT, i.e. a subquery/CTE layer this v1 compiler never
    // emits.
    return pushedKindsSoFar.every((k) => k === "filter");
  },

  blocksFollowingPushdown: true,

  emitSql(step, ctx) {
    const groupByCols = step.groupBy.map((f) => ctx.adapter.quoteIdent(f));
    const aggCols = step.aggregations.map((a) => `${ctx.adapter.compileAggAccumulator(a)} AS ${ctx.adapter.quoteIdent(a.alias)}`);
    // Phase 9 Part 4 follow-up (adversarial pagination case): mysql's
    // default column collation is case-insensitive for GROUP BY/ORDER BY
    // too, not just the WHERE/HAVING literal comparisons Fix 1
    // (sqlShared.ts) already forces BINARY on — confirmed live: "a" and
    // "A" silently collapsed into one GROUP BY group (their aggregates
    // summed together) while postgres/mongo/residual correctly kept them
    // separate. Force byte-wise grouping/ordering the same way, applied to
    // EVERY groupBy column unconditionally regardless of type: this is
    // always a self-comparison of one column's value against itself across
    // rows (never against a differently-typed literal or column, unlike
    // Fix 1's guarded cases), and a given column's canonical string form is
    // consistent row-to-row, so forcing BINARY here can't split two truly
    // equal values apart.
    //
    // This sandbox's default sql_mode includes ONLY_FULL_GROUP_BY, which
    // then rejects a plain `SELECT col` whose expression doesn't textually
    // match the `BINARY col` GROUP BY expression (verified live: error
    // 1055). `ANY_VALUE()` is mysql's documented escape hatch for exactly
    // this — it tells the optimizer any row's value is acceptable, which
    // is safe here since BINARY grouping already guarantees every row in a
    // reported group shares the same value. Unlike the GROUP BY/ORDER BY
    // columns, the SELECT list must NOT itself use BINARY: that would
    // return a VARBINARY value from the driver instead of the original
    // column's string, corrupting the row payload.
    // Aliased back to the plain column name: without `AS`, mysql reports the
    // result column's name as the full `ANY_VALUE(...)` expression text
    // instead of the original field name, breaking every downstream
    // column-name lookup (queryBuilder/runEtl/preview mapping all key rows by
    // field name, not position).
    const selectGroupByCols = ctx.adapter.dialect === "mysql" ? groupByCols.map((c) => `ANY_VALUE(${c}) AS ${c}`) : groupByCols;
    const groupOrderCols = ctx.adapter.dialect === "mysql" ? groupByCols.map((c) => `BINARY ${c}`) : groupByCols;

    // Fix (numeric group keys under MySQL pagination): groupOrderCols above
    // forces byte-wise ORDER BY for every groupBy column unconditionally,
    // regardless of type — necessary for string collation (see the comment
    // above), but that means ORDER BY sorts a numeric column lexicographically
    // ("10" before "9"). The WHERE-side keyset comparison
    // (pushdown.ts's buildGroupKeysetWhereSql) must compare using that exact
    // same byte order or a small page size can skip/duplicate groups. Since
    // we have no column-type metadata here (Phase 10 TODO), the fix is
    // type-agnostic: for mysql, additionally select each groupBy column's
    // byte-order encoding under a hidden alias, and hand the alias list back
    // via `cursorColumns` so pushdown.ts can read the CURSOR from these
    // columns (not from the plain, type-native-rendered groupBy column —
    // e.g. a DECIMAL(10,2) renders as the driver string "10.00" while a
    // JS-side re-render of the same value could produce "10", corrupting a
    // persisted/re-bound cursor) and compare against them using the same
    // encoding on the next page's WHERE fragment.
    //
    // `HEX(BINARY col)` rather than a bare `BINARY col`: HEX-encoding is a
    // strictly order-preserving, byte-for-byte bijection (each source byte
    // maps to a fixed 2-uppercase-hex-char block), so comparing the HEX
    // strings sorts identically to comparing the raw BINARY bytes that
    // ORDER BY already sorts by — while always yielding a plain ASCII
    // string. A raw `CAST(col AS BINARY)` returns a VARBINARY value that
    // this project's mysql connector (no custom typeCast configured)
    // returns as a Node Buffer, which doesn't round-trip through a
    // JSON-persisted cursor or a re-bound string query parameter safely.
    // `ANY_VALUE(...)`-wrapped for the same ONLY_FULL_GROUP_BY reason as
    // selectGroupByCols above.
    const cursorColumns =
      ctx.adapter.dialect === "mysql" && step.groupBy.length > 0
        ? step.groupBy.map((_, i) => `__nia_group_cursor_${i}`)
        : null;
    const cursorSelectCols =
      cursorColumns && ctx.adapter.dialect === "mysql"
        ? groupByCols.map((c, i) => `ANY_VALUE(HEX(BINARY ${c})) AS ${ctx.adapter.quoteIdent(cursorColumns[i]!)}`)
        : [];
    const fullSelect = [...selectGroupByCols, ...aggCols, ...cursorSelectCols];

    let havingSql: string | null = null;
    if (step.having) {
      const conditions = exprToConditions(step.having);
      if (conditions) {
        if (conditions.length > 0) {
          const fragments = conditions.map((cond) => {
            const agg = step.aggregations.find((a) => a.alias === cond.field);
            return agg
              ? ctx.adapter.compileConditionAgainstTarget(ctx.adapter.compileAggAccumulator(agg), cond, ctx.params)
              : ctx.adapter.compileCondition(cond, ctx.params);
          });
          havingSql = ctx.adapter.combineAnd(fragments);
        }
      } else {
        havingSql = compileHavingViaSubstitution(step.having, ctx, step.aggregations);
      }
      // Phase 8b-3 / Phase 9 Part 4: `having` compiles the same way here
      // regardless of whether it contains a fallible call — isPushable's
      // fallibleStepIsPushable check only blocks pushdown for policy
      // "quarantine" now, so a fallible "fail"/"null"/"drop" having reaches
      // this emit path same as any other. Its failure-counting concern is
      // handled separately, before extraction, by pushdown.ts's
      // compileFailurePreChecks — nothing further to do here.
    }

    ctx.setAggregate(fullSelect, groupOrderCols.length ? groupOrderCols : null, havingSql, cursorColumns);
  },

  emitMongo(step, ctx) {
    const groupId: Record<string, unknown> = {};
    for (const field of step.groupBy) groupId[field] = `$${field}`;

    const groupStage: Record<string, unknown> = { _id: step.groupBy.length ? groupId : null };
    const addFields: Record<string, unknown> = {};
    const projectDrop: Record<string, unknown> = { _id: 0 };

    for (const field of step.groupBy) addFields[field] = `$_id.${field}`;

    for (const agg of step.aggregations) {
      if (agg.fn === "count_distinct") {
        const tempField = `__distinct_${agg.alias}`;
        groupStage[tempField] = { $addToSet: agg.field ? `$${agg.field}` : null };
        addFields[agg.alias] = { $size: `$${tempField}` };
        projectDrop[tempField] = 0;
      } else {
        groupStage[agg.alias] = ctx.adapter.compileAggAccumulator(agg);
      }
    }

    ctx.push({ $group: groupStage });
    ctx.push({ $addFields: addFields });
    ctx.push({ $project: projectDrop });

    if (step.having) {
      // Phase 8b-3 / Phase 9 Part 4: `having` compiles the same way here
      // regardless of whether it contains a fallible call, matching emitSql
      // — see that comment for why (only "quarantine" still forces
      // residual; failure counting for a pushed having is handled
      // separately by pushdown.ts's compileFailurePreChecks).
      const conditions = exprToConditions(step.having);
      if (conditions) {
        if (conditions.length > 0) {
          const clauses = conditions.map((cond) => ctx.adapter.compileCondition(cond));
          const combined = ctx.adapter.combineAnd(clauses);
          if (combined) ctx.push({ $match: combined });
        }
      } else {
        ctx.push({ $match: { $expr: ctx.adapter.compileExpr(step.having) } });
      }
    }

    ctx.markAggregate();
  },

  transformOutputShape(step) {
    const next = new Set<string>();
    for (const f of step.groupBy) next.add(f);
    for (const a of step.aggregations) if (a.alias) next.add(a.alias);
    return next;
  },

  createAccumulator(step) {
    return createAggregateAccumulator(step);
  },

  applyResidual(input, step) {
    const acc = createAggregateAccumulator(step);
    acc.feed(input.rows);
    return acc.finalize();
  },

  checkConfig(step, ctx) {
    const messages: string[] = [];
    // Ruling 4: alias collisions must be checked against groupBy field names
    // too, not just sibling aggregation aliases.
    const seenNames = new Set<string>(step.groupBy);
    for (const agg of step.aggregations) {
      if (agg.alias === "") {
        messages.push(`aggregate step ${ctx.index + 1} has an aggregation with no output alias.`);
        continue;
      }
      if (agg.fn !== "count" && !agg.field) {
        messages.push(`aggregate step ${ctx.index + 1}'s "${agg.alias}" aggregation (${agg.fn}) has no field selected.`);
      }
      if (seenNames.has(agg.alias)) {
        messages.push(`aggregate step ${ctx.index + 1} has more than one output named "${agg.alias}" (aggregation alias or groupBy field).`);
      }
      seenNames.add(agg.alias);
    }

    // Ruling 2: a having condition may reference ONLY an aggregation alias or
    // a groupBy field — never a raw upstream (pre-aggregate) field.
    if (step.having) {
      const allowedNames = new Set<string>([...step.groupBy, ...step.aggregations.map((a) => a.alias)]);
      for (const name of collectFieldRefs(step.having)) {
        if (!allowedNames.has(name)) {
          messages.push(
            `aggregate step ${ctx.index + 1}'s having condition references "${name}", which is neither an aggregation alias nor a groupBy field on this step.`,
          );
        }
      }
    }

    return messages;
  },

  /**
   * Phase 11 Block 2E — a graph whose last step is this aggregate writes
   * staging rows shaped by `groupBy`, so staging must hold one row per
   * group, the same uniqueness its own destination upsert/replace already
   * relies on. runEtl.ts only collects this from the graph's LAST step
   * (staging holds that step's output shape, not an intermediate one).
   */
  stagingAssertions(step) {
    return step.groupBy.length > 0 ? [{ kind: "uniqueColumns", columns: step.groupBy }] : [];
  },
};
