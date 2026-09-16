import type { TabularResult } from "@nia/schemas";
import type { ReductionPlan } from "../../llm/prompts/reductionPlan.js";

/**
 * The ONLY place reduction arithmetic happens — never the model. This is a
 * deliberate, load-bearing decision, not just tidiness:
 *
 * Faithfulness-checking (../nodes/faithfulness.ts, and this pipeline's
 * faithfulnessMulti.ts) only verifies that the claims in an answer appear in
 * the retrieved rows. It is structurally BLIND to arithmetic/reduction
 * errors — a wrong reduction (e.g. averaging two per-source maxima instead
 * of taking the true union max, or silently using only one source's number)
 * would still cite real numbers that really did come from real rows, so it
 * would still pass a faithfulness check built to catch hallucination, not
 * arithmetic. That is a categorically different, and otherwise
 * undetectable, failure mode. Confining MAX/MIN/SUM/COUNT to plain, unit-
 * tested TypeScript removes the model from the one step where an error
 * could ship with a passing faithfulness grade.
 */

export interface SourceRows {
  connectionId: string;
  result: TabularResult;
}

export interface ReduceWinner {
  connectionId: string;
  row: unknown[];
  columns: TabularResult["columns"];
}

export type ReduceOutcome =
  | {
      ok: true;
      operation: "max" | "min";
      value: number;
      /**
       * ALL rows tying for the extreme value, across ALL sources — see the
       * tie-handling decision below. Never just one, picked arbitrarily.
       */
      winners: ReduceWinner[];
    }
  | {
      ok: true;
      operation: "sum" | "count";
      value: number;
      contributingSources: string[];
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Tie-handling decision (Phase 3, made deliberately, not deferred): MAX/MIN
 * report ALL rows sharing the extreme value, across every source, rather
 * than silently picking one. Two rows sharing the top value is real data,
 * not malformed output, and refusing a legitimate question just because of
 * a tie would be a bug users hit. The per-source query-gen prompts
 * (../../llm/prompts/queryGen.*.ts) are instructed accordingly: no
 * `ORDER BY ... LIMIT 1` for a max/min plan — instead return every row
 * equal to the overall extreme, specifically so this function has the
 * chance to see (and report) a tie instead of it being silently broken
 * inside the query before reduce.ts ever runs.
 *
 * More than one winner is therefore NOT a shape violation — it is
 * surfaced to the caller (multiSource/nodes/verifyAndReduceNode.ts) as a
 * `conflict` stream event so the client can show it plainly, rather than
 * folded into free-text faithfulness prose.
 */
function reduceMaxMin(plan: Extract<ReductionPlan, { supported: true }>, sources: SourceRows[]): ReduceOutcome {
  const op = plan.operation as "max" | "min";
  let extreme: number | undefined;
  const rowsWithValue: (ReduceWinner & { value: number })[] = [];

  for (const source of sources) {
    // A truncated source is refused, not caveated, for max/min too: the
    // true extreme could be among the rows that got cut, and there is no
    // way to tell from here whether it was.
    if (source.result.meta.truncated) {
      return {
        ok: false,
        reason: `Source ${source.connectionId}'s result was truncated — cannot safely compute ${op} from a partial result set.`,
      };
    }

    const colIdx = source.result.columns.findIndex((c) => c.name === plan.targetField);
    if (colIdx === -1) {
      return {
        ok: false,
        reason: `Source ${source.connectionId} has no column "${plan.targetField}" to compute ${op} on.`,
      };
    }

    for (const row of source.result.rows) {
      const raw = row[colIdx];
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          reason: `Source ${source.connectionId}'s "${plan.targetField}" value is not numeric: ${JSON.stringify(raw)}.`,
        };
      }
      rowsWithValue.push({ connectionId: source.connectionId, row, columns: source.result.columns, value });
      if (extreme === undefined || (op === "max" ? value > extreme : value < extreme)) {
        extreme = value;
      }
    }
  }

  if (extreme === undefined) {
    return { ok: false, reason: "No rows were returned by any source." };
  }

  const winners = rowsWithValue.filter((r) => r.value === extreme).map(({ connectionId, row, columns }) => ({ connectionId, row, columns }));
  return { ok: true, operation: op, value: extreme, winners };
}

/**
 * SUM/COUNT truncation safety — VERIFIED, not assumed (see reduce.test.ts
 * and the comment on `queryGen.*.ts`'s reductionHint for the query-shape
 * side of this): every connector's row cap (services/connector-* /src/
 * index.ts) is applied AFTER the query executes, and @nia/guardrails' LIMIT
 * / `$limit` injection only bounds row COUNT — it never inspects whether a
 * query is a plain scalar aggregate or has a stray GROUP BY. A
 * `SELECT SUM(x) FROM t` with no GROUP BY always returns exactly one row
 * and can never be truncated, but nothing stops a model from generating a
 * spuriously grouped aggregate that returns many rows and DOES get capped.
 * There is no way to distinguish "one legitimate aggregate row" from "the
 * truncated output of a badly-shaped query" except by requiring exactly one
 * row AND `truncated === false` from every source — anything else is
 * refused, not caveated, because a wrong number with a caveat attached is
 * still a wrong number.
 *
 * Locating the aggregate VALUE within that one row is its own hazard,
 * caught live (see reduce.test.ts's mongo-shaped case): `plan.targetField`
 * names the INPUT field being summed/counted, not the output column's
 * name/alias — the SQL prompts (queryGen.{mysql,postgres}.ts) never alias
 * the aggregate at all (the column name is whatever the engine defaults
 * to), and the Mongo prompt (queryGen.mongo.ts) always names it "value" AND
 * (being a `$group`) always also emits an `_id` field alongside it. Naively
 * looking up `plan.targetField` by name and falling back to `row[0]` when
 * it isn't found is unsafe: for Mongo, `row[0]` can BE `_id` (typically
 * `null`), which coerces to 0 and silently drops that source's real value
 * from the total with no error. Instead: exclude any `_id` column (a
 * grouping artifact, never the aggregate itself) and require EXACTLY ONE
 * column to remain — anything else is an ambiguous shape and is refused,
 * not guessed at.
 */
function reduceSumCount(plan: Extract<ReductionPlan, { supported: true }>, sources: SourceRows[]): ReduceOutcome {
  const op = plan.operation as "sum" | "count";
  let total = 0;
  const contributingSources: string[] = [];

  for (const source of sources) {
    if (source.result.meta.truncated) {
      return {
        ok: false,
        reason: `Source ${source.connectionId}'s result was truncated — cannot safely compute a total from a partial result set.`,
      };
    }
    if (source.result.rows.length !== 1) {
      return {
        ok: false,
        reason: `Source ${source.connectionId} returned ${source.result.rows.length} row(s) for a ${op} — expected exactly one aggregate row.`,
      };
    }

    const row = source.result.rows[0]!;
    const valueColIdxs = source.result.columns.map((_, i) => i).filter((i) => source.result.columns[i]!.name !== "_id");
    if (valueColIdxs.length !== 1) {
      return {
        ok: false,
        reason: `Source ${source.connectionId} returned an ambiguous aggregate row shape (columns: ${source.result.columns.map((c) => c.name).join(", ") || "none"}) — expected exactly one aggregate value column.`,
      };
    }
    const raw = row[valueColIdxs[0]!];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        reason: `Source ${source.connectionId}'s ${op} value is not numeric: ${JSON.stringify(raw)}.`,
      };
    }
    total += value;
    contributingSources.push(source.connectionId);
  }

  return { ok: true, operation: op, value: total, contributingSources };
}

/**
 * Verifies (never trusts) each source's shape against the plan before
 * reducing — a mismatch refuses rather than coerces. `sources` must already
 * be the full set of successfully-dispatched sources; partial-failure
 * handling (a source that errored or timed out) happens one level up in
 * multiSource/nodes/verifyAndReduceNode.ts, before this is ever called —
 * this function has no visibility into sources that didn't make it back at
 * all, so it can't refuse on their behalf.
 */
export function reduce(plan: ReductionPlan, sources: SourceRows[]): ReduceOutcome {
  if (!plan.supported) {
    return { ok: false, reason: plan.reason };
  }
  if (sources.length === 0) {
    return { ok: false, reason: "No source results to reduce." };
  }
  return plan.operation === "max" || plan.operation === "min" ? reduceMaxMin(plan, sources) : reduceSumCount(plan, sources);
}
