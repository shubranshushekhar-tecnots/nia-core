/**
 * ParamSink — Phase 8b-2 Follow-up 1 fix for the arg(n)/params-array
 * desync bug family. Full story in docs/decisions.md's Follow-up 1 entry;
 * short version: 4 WITHIN-one-expression instances were found and fixed
 * earlier (quotient, compileTrueTypeSql, date_add's null-guard, plus one
 * more), and a 5th, CROSS-FRAGMENT instance was live-confirmed via
 * apps/worker/scripts/lib/agreementCases.ts's "cross-fragment param-order
 * regression guard" case: a `filter` step's literal (lands in `whereSql`)
 * and a `computed_field` step's literal (lands in `selectSql`) got bound
 * to the WRONG mysql `?` once pushdown.ts's `compileSql` combined both
 * fragments into one query — because every leaf param-push site chose its
 * placeholder from `params.length` at JS-CALL-ORDER time, which can
 * diverge from the eventual PHYSICAL TEXT ORDER of the fully assembled
 * query (mysql's anonymous `?` binds by the driver's left-to-right scan
 * of the final text, not by any number baked into the placeholder).
 *
 * Root cause was contained to exactly 5 leaf call sites in sqlShared.ts —
 * the only places that ever call `params.push` + choose a placeholder
 * directly; every other call-fn (the ~80 math/text/coercion/date
 * implementations) funnels through these via recursive `compileExpr`
 * calls and needed no change.
 *
 * Fix: those 5 sites no longer choose a real placeholder immediately.
 * They record `{token, value}` on a ParamSink and inline an opaque TOKEN
 * in the fragment text instead. Once per `compileSql` call (pushdown.ts),
 * `resolveParamSink` walks every fragment in REAL SQL clause/physical
 * order (`selectSql -> whereSql -> groupBySql -> havingSql`) and swaps
 * each token for the dialect's real placeholder, building the final
 * params array purely from that scan order — so binding is always
 * derived from physical text position, never from JS evaluation order.
 * Applied uniformly to both mysql and postgres: postgres's `$N`
 * placeholders bind by number, not position, so they don't strictly need
 * this, but resolving both the same way keeps the two code paths
 * identical instead of special-casing one of them.
 *
 * mongo.ts is entirely unaffected: it has no positional-placeholder/
 * params-array concept at all — literal values are embedded directly
 * into the BSON pipeline object tree, never through this module.
 */

/**
 * Delimiter character for a token. NUL (`\u0000`) specifically because it
 * cannot appear in any customer-controlled SQL identifier: both dialect
 * adapters' `quoteIdent` (sqlShared.ts's `makeSqlDialectAdapter`) throw if
 * a name contains it — see that file's `quoteIdent` wrapper and its test
 * in pushdown.test.ts. It also cannot appear in a parameterized literal
 * VALUE, since literal values never get embedded as raw text in the first
 * place — they always go through this same ParamSink and become a
 * token/placeholder, never inline text.
 */
export const PARAM_TOKEN_CHAR = "\u0000";

const TOKEN_RE = new RegExp(`${PARAM_TOKEN_CHAR}(\\d+)${PARAM_TOKEN_CHAR}`, "g");

/** Public surface threaded through SqlDialectAdapter/SqlEmitContext — deliberately just `push`; nothing outside this module ever needs to read what's been recorded. */
export interface ParamSink {
  /** Records `value` and returns an opaque TOKEN to embed inline in the compiled fragment text. This is NOT a real SQL placeholder — resolveParamSink swaps it for one later, once the fragment's final physical position is known. */
  push(value: unknown): string;
}

interface ParamSinkImpl extends ParamSink {
  readonly recorded: ReadonlyMap<string, unknown>;
}

export function createParamSink(): ParamSinkImpl {
  const recorded = new Map<string, unknown>();
  let n = 0;
  return {
    recorded,
    push(value: unknown): string {
      const token = `${PARAM_TOKEN_CHAR}${n}${PARAM_TOKEN_CHAR}`;
      n += 1;
      recorded.set(token, value);
      return token;
    },
  };
}

/**
 * Resolves every token recorded on `sink` against `fragments`, which MUST
 * be given in real SQL clause/physical order (this function trusts the
 * order it's handed — see pushdown.ts's compileSql for the actual order:
 * select, where, groupBy, having, matching queryBuilder.ts's real
 * `SELECT ... FROM ... WHERE ... GROUP BY ... HAVING ...` assembly).
 * `null` entries pass through unchanged (a clause that wasn't emitted).
 *
 * Returns the same fragments with every token swapped for a real dialect
 * placeholder, plus the params array built purely from left-to-right scan
 * order across all fragments combined — `String.prototype.replace` with a
 * global regex is spec-guaranteed to process matches strictly left to
 * right within one string, and mapping the fragments array in its given
 * order extends that same left-to-right guarantee across fragments too.
 *
 * Condition 1 (docs/decisions.md, Follow-up 1): enforces EXACTLY-ONCE
 * token<->text correspondence in BOTH directions — throws if a token
 * appears in text more than once (duplicate/forged), if a token appears
 * in text that was never recorded (forged/foreign), or if a recorded
 * token never appears in any fragment (orphaned). This output goes to
 * guardrails and then executes; a duplicated/forged/orphaned token
 * silently substituting into the wrong position would be worse than the
 * bug this fix closes, so any mismatch is a loud failure, never silent.
 */
export function resolveParamSink<T extends readonly (string | null)[]>(
  sink: ParamSinkImpl,
  fragments: T,
  placeholder: (index: number) => string,
): { resolved: T; params: unknown[] } {
  const params: unknown[] = [];
  const seen = new Set<string>();
  const resolved = fragments.map((fragment) => {
    if (fragment === null) return null;
    return fragment.replace(TOKEN_RE, (match) => {
      if (seen.has(match)) {
        throw new Error(
          `ParamSink: token ${JSON.stringify(match)} appears more than once in emitted SQL text — refusing to bind (duplicate/forged token).`,
        );
      }
      if (!sink.recorded.has(match)) {
        throw new Error(
          `ParamSink: token ${JSON.stringify(match)} found in emitted SQL text but was never recorded — refusing to bind (forged/foreign token).`,
        );
      }
      seen.add(match);
      params.push(sink.recorded.get(match));
      return placeholder(params.length);
    });
  });
  if (seen.size !== sink.recorded.size) {
    const orphaned = [...sink.recorded.keys()].filter((t) => !seen.has(t));
    throw new Error(
      `ParamSink: ${orphaned.length} recorded token(s) never appeared in any emitted SQL fragment — refusing to bind (orphaned token(s): ${orphaned.join(", ")}).`,
    );
  }
  // `Array.prototype.map` widens a tuple type T to a plain array; the cast
  // is safe because `.map()` preserves length/order 1:1 with `fragments`,
  // so `resolved` always has exactly T's shape at runtime.
  return { resolved: resolved as unknown as T, params };
}
