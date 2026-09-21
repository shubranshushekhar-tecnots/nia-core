import { AggregateStep, type AggregateStep as AggregateStepT, type AggregationSpec, exprToConditions } from "../nodeConfig.js";
import { collectFieldRefs, type Expr } from "../expression.js";
import type { OpKind, OpModule, SqlEmitContext } from "./types.js";
import { exprFnsPushable } from "./types.js";
import { evalExpr } from "./residualEval.js";
import { computeFailureReport, fallibleStepIsPushable, quarantineMessage, resolveOnFailure } from "./onFailure.js";

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
    // filter), so "null"/"drop" push normally with zero extra code —
    // no failure count is observable for a pushed group though (only a
    // residually executed step counts failures; same documented v1
    // trade-off as filter.ts — see onFailure.ts's top doc comment).
    // "fail"/"quarantine" are always forced residual
    // (fallibleStepIsPushable).
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
    const fullSelect = [...groupByCols, ...aggCols];

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
      // Phase 8b-3: a fallible call inside `having`, if present, already
      // forced this step residual (isPushable's fallibleStepIsPushable
      // check) — nothing further to emit here.
    }

    ctx.setAggregate(fullSelect, groupByCols.length ? groupByCols : null, havingSql);
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
      // Phase 8b-3: a fallible call inside `having`, if present, already
      // forced this step residual (isPushable's fallibleStepIsPushable
      // check) — nothing further to emit here, matching emitSql.
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

  applyResidual(input, step) {
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

    for (const row of input.rows) {
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
      const quarantine = quarantineMessage(step, step.having);
      if (quarantine) messages.push(`aggregate step ${ctx.index + 1}: ${quarantine}`);
    }

    return messages;
  },
};
