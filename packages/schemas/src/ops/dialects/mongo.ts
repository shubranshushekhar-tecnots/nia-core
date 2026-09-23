import { type Expr, typeOfExpr } from "../../expression.js";
import type { AggregationSpec, FilterCondition } from "../../nodeConfig.js";
import type { MongoDialectAdapter } from "../types.js";

/** Escapes regex metacharacters so "contains" means literal substring search, never an attacker/user-controlled regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileCondition(cond: FilterCondition): Record<string, unknown> {
  switch (cond.operator) {
    case "eq":
      return { [cond.field]: { $eq: cond.value } };
    case "neq":
      return { [cond.field]: { $ne: cond.value } };
    case "gt":
      return { [cond.field]: { $gt: cond.value } };
    case "gte":
      return { [cond.field]: { $gte: cond.value } };
    case "lt":
      return { [cond.field]: { $lt: cond.value } };
    case "lte":
      return { [cond.field]: { $lte: cond.value } };
    case "contains": {
      // Phase 8b-2b: case-SENSITIVE by default; "i" only when explicitly requested.
      const regex: Record<string, unknown> = { $regex: escapeRegExp(String(cond.value ?? "")) };
      if (cond.caseInsensitive) regex.$options = "i";
      return { [cond.field]: regex };
    }
    case "is_null":
      return { [cond.field]: { $eq: null } };
    case "is_not_null":
      return { [cond.field]: { $ne: null } };
  }
}

/**
 * MongoDB has no native `$sign` aggregation expression operator — verified
 * against MongoDB 7.0's own source (no `REGISTER_STABLE_EXPRESSION` for
 * "sign" anywhere in expression.cpp) and confirmed live against a real
 * MongoDB 7.0.40 sandbox server ("Unknown expression $sign", while
 * $abs/$ceil/$floor/$trunc/$round on the same server all work fine). This
 * was a genuine bug in this file, not a guardrails/version/connector
 * issue — built here instead from $switch + $gt/$lt (both real operators),
 * with an explicit x-IS-NULL guard ahead of the switch so null propagates
 * (the switch's default branch would otherwise wrongly return 0 for null,
 * since neither $gt nor $lt matches null against 0).
 */
function mongoSign(x: unknown): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [x, null] },
      null,
      {
        $switch: {
          branches: [
            { case: { $gt: [x, 0] }, then: 1 },
            { case: { $lt: [x, 0] }, then: -1 },
          ],
          default: 0,
        },
      },
    ],
  };
}

const MATH_CALL_FNS = new Set([
  "abs",
  "ceil",
  "floor",
  "int",
  "trunc",
  "sign",
  "sqrt",
  "divide",
  "mod",
  "power",
  "quotient",
  "round",
  "round_up",
  "round_down",
  "round_to_multiple",
  "exp",
  "ln",
  "log",
]);

/**
 * Batch 1 (Phase 8b-2) — DAX-derived Math core, mirrors sqlShared.ts's
 * compileMathFnSql (see its doc comment for the full per-function
 * rationale: divide-by-zero contract, mod's DAX divisor-sign convention,
 * round/round_up/round_down/round_to_multiple built from
 * mongoSign()/$floor/$ceil/$abs/$pow rather than native $round — Mongo's
 * native $round uses round-half-to-even (banker's rounding), which
 * diverges from mysql/postgres/DAX's round-half-away-from-zero at exact
 * .5 boundaries, so it's homogenized by construction here too, not
 * declared). No positional-placeholder concern here (unlike SQL's mysql
 * `?`): a Mongo aggregation stage is a plain JS object tree, so a
 * compiled sub-expression can be safely bound to a local and reused
 * structurally without any duplicate-bind-param risk.
 *
 * Batch 2 (Phase 8b-2) — exp|ln|log, mirrors sqlShared.ts's batch 2 doc
 * comment for the full ln/log zero-and-negative contract and per-engine
 * native-behavior verification.
 */
function compileMathFnMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  switch (expr.fn) {
    case "abs":
      return { $abs: compileExpr(expr.args[0]!) };
    case "ceil":
      return { $ceil: compileExpr(expr.args[0]!) };
    case "floor":
    case "int":
      return { $floor: compileExpr(expr.args[0]!) };
    case "sign":
      return mongoSign(compileExpr(expr.args[0]!));
    case "sqrt": {
      const x = compileExpr(expr.args[0]!);
      return { $cond: [{ $lt: [x, 0] }, null, { $sqrt: x }] };
    }
    case "trunc":
      return { $trunc: compileExpr(expr.args[0]!) };
    case "power":
      return { $pow: [compileExpr(expr.args[0]!), compileExpr(expr.args[1]!)] };
    case "divide": {
      const num = compileExpr(expr.args[0]!);
      const denom = compileExpr(expr.args[1]!);
      const fallback = expr.args[2] ? compileExpr(expr.args[2]!) : null;
      // num-is-null checked first (mirrors sqlShared.ts's same fix): the
      // d=0 branch returns a non-null fallback, which must not fire ahead
      // of a null numerator.
      return { $cond: [{ $eq: [num, null] }, null, { $cond: [{ $eq: [denom, 0] }, fallback, { $divide: [num, denom] }] }] };
    }
    case "mod": {
      const n = compileExpr(expr.args[0]!);
      const d = compileExpr(expr.args[1]!);
      return { $cond: [{ $eq: [d, 0] }, null, { $subtract: [n, { $multiply: [d, { $floor: { $divide: [n, d] } }] }] }] };
    }
    case "quotient": {
      const n = compileExpr(expr.args[0]!);
      const d = compileExpr(expr.args[1]!);
      return { $cond: [{ $eq: [d, 0] }, null, { $trunc: { $divide: [n, d] } }] };
    }
    case "round":
    case "round_up":
    case "round_down": {
      const x = compileExpr(expr.args[0]!);
      const digits = expr.args[1] ? compileExpr(expr.args[1]!) : 0;
      const scale = { $pow: [10, digits] };
      const magnitude = { $multiply: [{ $abs: x }, scale] };
      if (expr.fn === "round_down") return { $divide: [{ $multiply: [mongoSign(x), { $floor: magnitude }] }, scale] };
      if (expr.fn === "round_up") return { $divide: [{ $multiply: [mongoSign(x), { $ceil: magnitude }] }, scale] };
      return { $divide: [{ $multiply: [mongoSign(x), { $floor: { $add: [magnitude, 0.5] } }] }, scale] };
    }
    case "round_to_multiple": {
      const x = compileExpr(expr.args[0]!);
      const m = compileExpr(expr.args[1]!);
      const absM = { $abs: m };
      // x-is-null checked first (same fix as divide above): the m=0
      // branch returns a non-null literal 0, which must not fire ahead of
      // a null x.
      return {
        $cond: [
          { $eq: [x, null] },
          null,
          {
            $cond: [
              { $eq: [m, 0] },
              0,
              { $multiply: [{ $multiply: [mongoSign(x), { $floor: { $add: [{ $divide: [{ $abs: x }, absM] }, 0.5] } }] }, absM] },
            ],
          },
        ],
      };
    }
    case "exp":
      return { $exp: compileExpr(expr.args[0]!) };
    case "ln": {
      const x = compileExpr(expr.args[0]!);
      // $ln (and $log below) are real Mongo operators — verified against
      // this project's own 7.0.40 sandbox — but unlike $sign they THROW a
      // runtime error for a non-positive argument ("$ln's argument must
      // be a positive number, but is 0/-1", verified live) rather than
      // nulling the row, which would fail the whole aggregation. Guarded
      // to match sqlShared.ts's ln/log contract (see its doc comment).
      return { $cond: [{ $lte: [x, 0] }, null, { $ln: x }] };
    }
    case "log": {
      const x = compileExpr(expr.args[0]!);
      if (!expr.args[1]) return { $cond: [{ $lte: [x, 0] }, null, { $ln: x }] };
      // $log's native arg order is [x, base] — already this grammar's
      // order, no swap needed (unlike sqlShared.ts's native base-first
      // LOG(base, x), see its doc comment). $log also throws for
      // base<=0/base=1 (verified live), guarded the same way.
      const base = compileExpr(expr.args[1]!);
      return { $cond: [{ $or: [{ $lte: [x, 0] }, { $lte: [base, 0] }, { $eq: [base, 1] }] }, null, { $log: [x, base] }] };
    }
    default:
      // Unreachable — callers only route here via MATH_CALL_FNS.has(expr.fn).
      throw new Error(`compileMathFnMongo: unhandled math fn "${expr.fn}"`);
  }
}

const TEXT_CALL_FNS = new Set(["upper", "lower", "trim", "left", "right", "mid", "len", "substitute", "find", "rept", "split"]);

/**
 * Batch 3 (Phase 8b-2) — DAX-derived Text core (+ split), mirrors
 * sqlShared.ts's compileTextFnSql (see its doc comment for the full
 * per-function contract, every claim there live-verified before being
 * pinned). Mongo-specific construction notes not already covered there:
 *  - upper/lower/len use $toUpper/$toLower/$strLenCP directly — $strLenCP
 *    is explicitly the CODE-POINT-counting variant (there's also a
 *    $strLenBytes), verified live to already agree with mysql/postgres's
 *    CHAR_LENGTH (12 for "café ñ 日本語 🎉" on all three).
 *  - find uses $indexOfCP (code-point-based, 0-based — converted to this
 *    grammar's 1-based contract via +1 after a found/not-found check,
 *    since Mongo's own not-found sentinel is already -1, not 0 — the
 *    +1 additionally needs a not-found guard so -1+1=0 isn't confused
 *    with a real position 1). Case-insensitive via $toLower-wrapping both
 *    operands, same pattern as compileContainsSql's caseInsensitive path.
 *  - left/right/mid/rept all pass their n/start args through explicit
 *    $max/$min clamps before ever reaching $substrCP/$reduce — the same
 *    "clamp before native call" requirement sqlShared.ts's doc comment
 *    explains (postgres's native negative-n divergence), applied
 *    preemptively here even though Mongo's own $substrCP has no
 *    documented negative-count special-casing of its own to diverge from
 *    — kept uniform with the other two adapters rather than trusted
 *    un-clamped.
 *  - substitute's empty-search guard is REQUIRED here, not just for
 *    parity: verified live that Mongo's native $replaceAll on an empty
 *    `find` does NOT error and does NOT no-op — it inserts `replacement`
 *    between every character ($replaceAll("abc","","X") = "XaXbXcX"),
 *    diverging from mysql/postgres's native no-op. Guarded via $cond
 *    ahead of $replaceAll.
 *  - split's empty-delimiter guard is REQUIRED, not just for parity:
 *    verified live that Mongo's $split THROWS a pipeline-optimization
 *    error on an empty separator ("$split requires a non-empty
 *    separator") — and MongoDB's $let evaluates its `vars` eagerly
 *    regardless of which `in` branch is chosen, so the guard must sit
 *    OUTSIDE the $let (never let $split be constructed at all when the
 *    delimiter is empty), not inside it as a post-hoc null-check.
 *  - Mongo has NO native repeat-string operator — rept is built from
 *    $reduce over $range(0, n), string-concatenating `text` n times; n is
 *    clamped+integer-converted via $toInt before $range (which requires
 *    integer bounds) to avoid a float/type error.
 *  - REQUIRED null-propagation guard, found live while agreement-testing
 *    this batch (not assumed up front): Mongo's string operators do NOT
 *    propagate a null/missing input to a null result the way its
 *    arithmetic operators do (compileMathFnMongo needs no such guard —
 *    verified those already null-propagate natively). Per Mongo's own
 *    docs, confirmed live: $toUpper/$toLower/$substrCP/$trim on a null
 *    input silently return `""` (empty string, NOT null); $strLenCP on a
 *    null input THROWS ("$strLenCP requires a string argument, found:
 *    null") rather than either nulling or emptying. Both are wrong against
 *    this grammar's NULL-propagates contract (matches mysql/postgres's
 *    native CHAR_LENGTH(NULL)=NULL etc., and residualEval.ts's explicit
 *    null checks). Every case below is therefore wrapped in an explicit
 *    `$cond`-based null guard over its relevant operand(s) — evaluated
 *    BEFORE the real computation, and safe to nest since (unlike $let's
 *    eagerly-evaluated `vars`, see the split note above) $cond's branches
 *    are evaluated lazily: the guarded (potentially-crashing/wrong-on-null)
 *    computation never runs when the guard's null check is true.
 */
function textNullGuard(checkArgs: unknown[], value: unknown): unknown {
  const cond = checkArgs.length === 1 ? { $eq: [checkArgs[0], null] } : { $or: checkArgs.map((a) => ({ $eq: [a, null] })) };
  return { $cond: [cond, null, value] };
}

function compileTextFnMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  switch (expr.fn) {
    case "upper":
    case "lower":
      // Genuine impossibility, found live while agreement-testing this
      // batch — NOT a fixable bug. Verified directly against the sandbox
      // container: Mongo's $toUpper/$toLower ONLY transform ASCII a-z/A-Z;
      // "café" -> "CAFé" (é left untouched), diverging from mysql/
      // postgres's collation-aware full-Unicode case mapping ("café" ->
      // "CAFÉ") and from residualEval.ts's JS String#toUpperCase (also
      // full-Unicode). Mongo's aggregation pipeline has no other
      // Unicode-aware case-folding operator ($function's server-side JS
      // eval is out of scope: no other DialectAdapter member does this,
      // and it would be a new, inconsistent mechanism just for these two
      // functions). Declared non-pushable on mongo instead of homogenized
      // — see FN_PUSHABILITY in ops/types.ts and docs/decisions.md's
      // batch 3 entry. This case is unreachable through the normal
      // pushdown path (isPushable already routes any step using upper/
      // lower to residual on mongo before compileMongo ever runs) — kept
      // as an explicit throw, not silently falling through to another
      // case below, as a defense-in-depth guard against ever compiling a
      // fn declared non-pushable.
      throw new Error(`compileTextFnMongo: "${expr.fn}" is not pushable on mongo (FN_PUSHABILITY.${expr.fn}.mongo is false) — this call should have been routed to residual, not compiled`);
    case "trim": {
      // Explicit `chars` (not Mongo's own default) pins the exact
      // ASCII-whitespace set, matching sqlShared.ts's ASCII_WS rather than
      // relying on Mongo's own (verified-live, but undeclared-contract)
      // default whitespace set.
      const x = compileExpr(expr.args[0]!);
      return textNullGuard([x], { $trim: { input: x, chars: " \t\n\r\f\u000B" } });
    }
    case "left": {
      const x = compileExpr(expr.args[0]!);
      const nRaw = compileExpr(expr.args[1]!);
      const n = { $max: [nRaw, 0] };
      return textNullGuard([x, nRaw], { $substrCP: [x, 0, n] });
    }
    case "right": {
      const x = compileExpr(expr.args[0]!);
      const nRaw = compileExpr(expr.args[1]!);
      const n = { $max: [nRaw, 0] };
      const len = { $strLenCP: x };
      const start = { $max: [{ $subtract: [len, n] }, 0] };
      return textNullGuard([x, nRaw], { $substrCP: [x, start, n] });
    }
    case "mid": {
      const x = compileExpr(expr.args[0]!);
      const startRaw = compileExpr(expr.args[1]!);
      const nRaw = compileExpr(expr.args[2]!);
      const start1based = { $max: [startRaw, 1] };
      const n = { $max: [nRaw, 0] };
      return textNullGuard([x, startRaw, nRaw], { $substrCP: [x, { $subtract: [start1based, 1] }, n] });
    }
    case "len": {
      const x = compileExpr(expr.args[0]!);
      return textNullGuard([x], { $strLenCP: x });
    }
    case "substitute": {
      const text = compileExpr(expr.args[0]!);
      const search = compileExpr(expr.args[1]!);
      const replacement = compileExpr(expr.args[2]!);
      return textNullGuard(
        [text, search, replacement],
        { $cond: [{ $eq: [search, ""] }, text, { $replaceAll: { input: text, find: search, replacement } }] },
      );
    }
    case "find": {
      const needle = compileExpr(expr.args[0]!);
      const haystack = compileExpr(expr.args[1]!);
      const caseInsensitiveArg = expr.args[2];
      const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
      const n = caseInsensitive ? { $toLower: needle } : needle;
      const h = caseInsensitive ? { $toLower: haystack } : haystack;
      const idx0 = { $indexOfCP: [h, n] };
      return textNullGuard([needle, haystack], { $cond: [{ $eq: [idx0, -1] }, 0, { $add: [idx0, 1] }] });
    }
    case "rept": {
      const x = compileExpr(expr.args[0]!);
      const nRaw = compileExpr(expr.args[1]!);
      const n = { $toInt: { $min: [{ $max: [nRaw, 0] }, 1000] } };
      return textNullGuard([x, nRaw], { $reduce: { input: { $range: [0, n] }, initialValue: "", in: { $concat: ["$$value", x] } } });
    }
    case "split": {
      const text = compileExpr(expr.args[0]!);
      const delim = compileExpr(expr.args[1]!);
      const index = compileExpr(expr.args[2]!);
      return textNullGuard(
        [text, delim, index],
        {
          $cond: [
            { $or: [{ $eq: [delim, ""] }, { $lt: [index, 1] }] },
            null,
            {
              $let: {
                vars: { parts: { $split: [text, delim] } },
                in: {
                  $cond: [{ $gt: [index, { $size: "$$parts" }] }, null, { $arrayElemAt: ["$$parts", { $subtract: [index, 1] }] }],
                },
              },
            },
          ],
        },
      );
    }
    default:
      // Unreachable — callers only route here via TEXT_CALL_FNS.has(expr.fn).
      throw new Error(`compileTextFnMongo: unhandled text fn "${expr.fn}"`);
  }
}

const COERCE_NUM_REGEX = "^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]{1,4})?$";

/**
 * Batch 4 (Phase 8b-2) — Coercion vocabulary. Mirrors sqlShared.ts's
 * compileCoercionFnSql exactly (same numeric regex, same overflow
 * heuristic, same round-half-away-from-zero digit formula) — see its doc
 * comment for the full per-function contract. Mongo has no bind-param
 * desync risk (pipelines are plain JS objects, not SQL text), so unlike
 * sqlShared.ts's closures these helpers freely reuse a `const` expression
 * tree at multiple embed points; MongoDB re-evaluates each reference
 * independently at runtime with no side effects, so this is safe.
 *
 * NULL handling: every helper below explicit-guards its root arg for
 * `null` BEFORE constructing $trim/$toString/$strLenCP/etc. calls on it —
 * required per this file's TEXT_CALL_FNS doc comment ($trim/$toUpper on a
 * null input silently return "", $strLenCP throws), never relying on
 * their native null behavior. Safe to nest because $cond's branches are
 * evaluated lazily (same established pattern as textNullGuard above).
 */
function coerceNumberMongo(argExpr: Expr): unknown {
  if (typeOfExpr(argExpr) === "boolean") return null;
  const x = compileExpr(argExpr);
  const text = { $trim: { input: { $toString: x } } };
  const matches = { $regexMatch: { input: text, regex: COERCE_NUM_REGEX } };
  const ePos = { $indexOfCP: [{ $toUpper: text }, "E"] };
  const hasExp = { $ne: [ePos, -1] };
  const expText = { $substrCP: [text, { $add: [ePos, 1] }, { $subtract: [{ $strLenCP: text }, { $add: [ePos, 1] }] }] };
  const expMagnitude = { $abs: { $toDouble: expText } };
  const textLen = { $strLenCP: text };
  return {
    $cond: [
      { $eq: [x, null] },
      null,
      {
        $cond: [
          { $not: [matches] },
          null,
          {
            $cond: [
              { $and: [hasExp, { $gt: [expMagnitude, 308] }] },
              null,
              { $cond: [{ $and: [{ $not: [hasExp] }, { $gt: [textLen, 320] }] }, null, { $toDouble: text }] },
            ],
          },
        ],
      },
    ],
  };
}

/** decimals arg, coerced/truncated/clamped to [0,10]. Explicit NULL guard BEFORE $min/$max — required: Mongo's array-form $min/$max IGNORE null operands (same divergence risk as postgres's GREATEST/LEAST, see sqlShared.ts's clampedDecimalsSql doc comment). */
function clampedDecimalsMongo(argExpr: Expr): unknown {
  const num = coerceNumberMongo(argExpr);
  const truncated = { $trunc: num };
  return { $cond: [{ $eq: [num, null] }, null, { $min: [{ $max: [truncated, 0] }, 10] }] };
}

/** Round-half-away-from-zero digit construction — mirrors sqlShared.ts's compileFormatDecimalSql (POWER/FLOOR/LPAD -> $pow/$floor/$reduce+$range since Mongo has no native LPAD; trailing-zero strip uses native $rtrim with an explicit chars:"0"). `value`/`decimals` are already-null-checked Mongo expressions (coerceNumberMongo/clampedDecimalsMongo's own results, or a literal like 6 for to_text) — still re-guarded here for direct callers. */
function formatDecimalMongo(value: unknown, decimals: unknown, stripTrailingZeros: boolean): unknown {
  const scale = { $pow: [10, decimals] };
  const scaled = { $floor: { $add: [{ $multiply: [{ $abs: value }, scale] }, 0.5] } };
  const intPart = { $floor: { $divide: [scaled, scale] } };
  const fracPart = { $subtract: [scaled, { $multiply: [intPart, scale] }] };
  const intText = { $toString: intPart };
  const fracRawText = { $toString: fracPart };
  const padLen = { $max: [{ $subtract: [decimals, { $strLenCP: fracRawText }] }, 0] };
  const zeros = { $reduce: { input: { $range: [0, padLen] }, initialValue: "", in: { $concat: ["$$value", "0"] } } };
  const fracPadded = { $concat: [zeros, fracRawText] };
  const frac = stripTrailingZeros ? { $rtrim: { input: fracPadded, chars: "0" } } : fracPadded;
  const sign = { $cond: [{ $and: [{ $lt: [value, 0] }, { $ne: [scaled, 0] }] }, "-", ""] };
  const withFrac = { $concat: [sign, intText, ".", frac] };
  const withoutFrac = { $concat: [sign, intText] };
  const body = stripTrailingZeros
    ? { $cond: [{ $eq: [frac, ""] }, withoutFrac, withFrac] }
    : { $cond: [{ $eq: [decimals, 0] }, withoutFrac, withFrac] };
  return { $cond: [{ $or: [{ $eq: [value, null] }, { $eq: [decimals, null] }] }, null, body] };
}

/** to_text's scalar (non-statically-boolean) branch: runtime $isNumber dispatch to formatDecimalMongo(x, 6, true) vs plain $toString. */
function compileNumberOrTextToTextMongo(argExpr: Expr): unknown {
  const x = compileExpr(argExpr);
  const numText = formatDecimalMongo(x, 6, true);
  return { $cond: [{ $eq: [x, null] }, null, { $cond: [{ $isNumber: x }, numText, { $toString: x }] }] };
}

/** NULL -> NULL; static-boolean passthrough; runtime number: 1->true/0->false/else NULL; runtime string: trim+lowercase, 'true'|'1'->true, 'false'|'0'->false, else NULL. */
function compileToBooleanMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  if (typeOfExpr(expr.args[0]!) === "boolean") return compileExpr(expr.args[0]!);
  const x = compileExpr(expr.args[0]!);
  const numBranch = { $cond: [{ $eq: [x, 1] }, true, { $cond: [{ $eq: [x, 0] }, false, null] }] };
  const s = { $trim: { input: { $toLower: { $toString: x } } } };
  const strBranch = { $cond: [{ $in: [s, ["true", "1"]] }, true, { $cond: [{ $in: [s, ["false", "0"]] }, false, null] }] };
  return { $cond: [{ $eq: [x, null] }, null, { $cond: [{ $isNumber: x }, numBranch, strBranch] }] };
}

/**
 * ISO-8601-only fast path, mirrors sqlShared.ts's compileToDateSql exactly
 * (same 2 fixed-width shapes, same field-bounds check) but with $substrCP's
 * 0-based indexing (vs SQL's 1-based SUBSTRING) — position offsets shifted
 * accordingly: y=sub(0,4), mo=sub(5,2), d=sub(8,2), h=sub(11,2), mi=sub(14,2),
 * se=sub(17,2).
 */
function compileToDateMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  const x = compileExpr(expr.args[0]!);
  const s = { $trim: { input: { $toString: x } } };
  const pattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}:[0-9]{2})?Z?$";
  const matches = { $regexMatch: { input: s, regex: pattern } };
  const hasTime = { $gte: [{ $strLenCP: s }, 19] };
  const y = { $substrCP: [s, 0, 4] };
  const mo = { $substrCP: [s, 5, 2] };
  const d = { $substrCP: [s, 8, 2] };
  const h = { $cond: [hasTime, { $substrCP: [s, 11, 2] }, "00"] };
  const mi = { $cond: [hasTime, { $substrCP: [s, 14, 2] }, "00"] };
  const se = { $cond: [hasTime, { $substrCP: [s, 17, 2] }, "00"] };
  const boundsOk = {
    $and: [
      { $gte: [{ $toInt: mo }, 1] },
      { $lte: [{ $toInt: mo }, 12] },
      { $gte: [{ $toInt: d }, 1] },
      { $lte: [{ $toInt: d }, 31] },
      { $gte: [{ $toInt: h }, 0] },
      { $lte: [{ $toInt: h }, 23] },
      { $gte: [{ $toInt: mi }, 0] },
      { $lte: [{ $toInt: mi }, 59] },
      { $gte: [{ $toInt: se }, 0] },
      { $lte: [{ $toInt: se }, 59] },
    ],
  };
  return {
    $cond: [
      { $eq: [x, null] },
      null,
      {
        $cond: [
          { $not: [matches] },
          null,
          { $cond: [{ $not: [boundsOk] }, null, { $concat: [y, "-", mo, "-", d, "T", h, ":", mi, ":", se, "Z"] }] },
        ],
      },
    ],
  };
}

const COERCION_CALL_FNS = new Set(["to_number", "to_integer", "to_text", "format_number", "to_boolean", "to_date"]);

function compileCoercionFnMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  switch (expr.fn) {
    case "to_number":
      return coerceNumberMongo(expr.args[0]!);
    case "to_integer":
      return { $trunc: coerceNumberMongo(expr.args[0]!) };
    case "to_text": {
      if (typeOfExpr(expr.args[0]!) === "boolean") {
        const b = compileExpr(expr.args[0]!);
        return { $cond: [{ $eq: [b, null] }, null, { $cond: [b, "true", "false"] }] };
      }
      return compileNumberOrTextToTextMongo(expr.args[0]!);
    }
    case "format_number":
      return formatDecimalMongo(coerceNumberMongo(expr.args[0]!), clampedDecimalsMongo(expr.args[1]!), false);
    case "to_boolean":
      return compileToBooleanMongo(expr);
    case "to_date":
      return compileToDateMongo(expr);
    default:
      // Unreachable — callers only route here via COERCION_CALL_FNS.has(expr.fn).
      throw new Error(`compileCoercionFnMongo: unhandled coercion fn "${expr.fn}"`);
  }
}

/**
 * Phase 8b-2, pre-batch-5 hardening — mongo date-literal coercion for CASE
 * (`conditional`/$switch) branches. Mirrors sqlShared.ts's
 * ISO_DATE_LITERAL_RE/planDateStringCast/castAmbiguousLiteral mechanism —
 * same shape family, same "CASE-wide unanimous" trigger, same scope
 * (conditional branches only, never "literal"/"call"/"comparison"/
 * compileCondition generally) — but for a DIFFERENT underlying problem.
 * Postgres's version works around ambiguous bind-parameter TYPE
 * INFERENCE (a compile-time typing gap). Mongo's compileExpr has no
 * schema/column-type visibility at all (typeOfExpr only distinguishes
 * "scalar"/"boolean", nothing date-aware), so there's no type-inference
 * gap to paper over — the actual problem is that `case "literal": return
 * expr.value` emits a raw JS string with ZERO runtime coercion, and
 * mongo's $eq/$ne/etc. never coerce a string to a Date. A $switch whose
 * branches are date-shaped string literals, compared against a genuine
 * BSON Date field, silently matched zero rows (verified live:
 * agreementCases.ts's Fix-3 backfill case, now fixed by this).
 *
 * Scoped to `conditional` branches only, mirroring castAmbiguousLiteral's
 * own scope exactly — deliberately NOT extended to plain (non-
 * conditional) comparison sites. A blind $toDate wrap of any ISO-shaped
 * literal at a plain comparison site would break the different, equally
 * real case of that literal being compared against a genuine STRING
 * field that happens to hold matching ISO text (see the agreement case
 * documenting that false positive, immediately below the Fix-3-backfill
 * case in agreementCases.ts) — there is no schema signal here to
 * distinguish "the field is a real Date" from "the field is text that
 * looks like a date" the way postgres's own type system can. The trigger
 * below accepts exactly the same risk postgres's shipped fix already
 * accepts (content-shape-only, no inspection of what the CASE is later
 * compared against) — the mongo-side mirror of an already-reviewed risk,
 * not a new, larger one.
 *
 * The sanctioned path for an INTENTIONAL date comparison is an explicit
 * `to_date()` call in the expression — this heuristic is a bridge for
 * CASE branches only, not a general date-coercion story. Batch 5's ten
 * date-part functions need a separate, type-driven mechanism for their
 * own call arguments (every date function's own operator contract
 * requires a Date input, so wrapping is unconditional there, not a
 * content-shape guess) — see docs/decisions.md.
 */
const ISO_DATE_LITERAL_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}:[0-9]{2})?Z?$/;
function planDateStringCast(resultExprs: Expr[]): boolean {
  const stringLiterals = resultExprs.filter(
    (e): e is Extract<Expr, { kind: "literal" }> & { value: string } => e.kind === "literal" && typeof e.value === "string",
  );
  return stringLiterals.length > 0 && stringLiterals.every((e) => ISO_DATE_LITERAL_RE.test(e.value));
}
function compileConditionalBranch(expr: Expr, castDateStrings: boolean): unknown {
  const compiled = compileExpr(expr);
  if (castDateStrings && expr.kind === "literal" && typeof expr.value === "string") return { $toDate: compiled };
  return compiled;
}

const DATE_CALL_FNS = new Set([
  "year", "month", "day", "hour", "minute", "second", "quarter", "weekday", "date_diff", "date_add",
]);

/**
 * Phase 8b-2, batch 5 — Date-part vocabulary, mongo side. Full contract in
 * docs/decisions.md's batch 5 entry (shared across all 3 dialects); this
 * comment covers only mongo's construction strategy.
 *
 * Type-driven coercion: a single unconditional `$convert` (to: "date",
 * onError: null, onNull: null) per date-typed arg — NOT the
 * planDateStringCast/compileConditionalBranch content-shape heuristic
 * above (that mechanism exists for a different problem: CASE/$switch
 * branch literal-casting, scoped to conditional branches only).
 * $convert's onError/onNull directly gives the "invalid or NULL -> NULL,
 * never throw" contract every one of these 10 functions needs, with none
 * of sqlShared.ts's regex-guard/pg_typeof scaffolding (mongo's $convert
 * already validates+casts+null-guards in one operator — there is no
 * native-hard-error case to route around the way postgres's blind
 * CAST(garbage AS timestamptz) has).
 *
 * Native operators used directly (all confirmed live via
 * apps/worker/scripts/date-part-fn-probe.ts, UTC-everywhere per this
 * batch's pin — mongo's default operator timezone is UTC and BSON Date
 * is a UTC epoch by construction, so no explicit `timezone` field is
 * passed anywhere here): $year/$month/$dayOfMonth/$hour/$minute/$second
 * for the single-part functions; $isoDayOfWeek for weekday (gives
 * Mon=1..Sun=7 directly, no remapping needed); $dateAdd for date_add
 * (confirmed live to clamp month-end the same as mysql/postgres's native
 * interval arithmetic — see month-add-clamp-probe.ts); $dateToString for
 * date_add's canonical-ISO-Z output formatting.
 *
 * date_diff deliberately does NOT use mongo's native $dateDiff operator
 * (available since MongoDB 5.0): its exact calendar-boundary-crossing
 * algorithm for day/hour/minute/second units was never live-verified
 * against this batch's specific contract (truncated epoch-difference ÷
 * unit-seconds), and risking a silent per-evaluator divergence is worse
 * than the extra verbosity of building date_diff from primitives already
 * confirmed live elsewhere in this batch ($subtract of two Dates gives
 * elapsed-ms directly; $year/$month give calendar-boundary year/month
 * counting) — the exact same two-part strategy sqlShared.ts uses.
 *
 * Unlike sqlShared.ts's string-templating (where mysql's positional `?`
 * placeholders force a "recompute per occurrence" discipline), every
 * value built here is a plain JS object reference — reusing the same
 * coerced-date object multiple times in one pipeline (e.g. startC/endC
 * below) is always safe, no analogous desync risk exists in mongo.
 *
 * ISO-8601-at-the-boundary gate, added after a live agreement-harness
 * finding: an unconditional `$convert{to:"date"}` on its own is NOT the
 * type-driven-only mechanism the doc block above describes — Mongo's own
 * date-string parser is MORE PERMISSIVE than strict ISO-8601 and silently
 * accepts at least some non-ISO-shaped strings (confirmed live:
 * `day("03/07/2024")` returned a real value instead of NULL, while
 * mysql/postgres/residual all correctly NULL a non-ISO string per this
 * batch's own ISO-8601 pin). Mirrors sqlShared.ts's compileDateCoerceSql
 * two-branch structure exactly: a genuine BSON Date passes straight
 * through (checked via `$type`, mongo's only runtime type signal — no
 * schema/pg_typeof equivalent exists here), a string is first gated
 * through the same `ISO_DATE_LITERAL_RE` shape check used above for CASE-
 * branch literals BEFORE ever reaching `$convert`, and anything else
 * (including a non-ISO-shaped string) is NULL without attempting
 * `$convert` at all. Numeric wrong-typed input was already unaffected by
 * this bug (confirmed live) because Mongo's `$convert` conversion table
 * has no double/int32 -> date path at all, so it already errored to NULL
 * via `onError` — this gate doesn't change that path, just closes the
 * string-leniency gap.
 */
function compileDateCoerceMongo(x: unknown): unknown {
  const isDate = { $eq: [{ $type: x }, "date"] };
  const isoShaped = { $regexMatch: { input: { $toString: x }, regex: ISO_DATE_LITERAL_RE.source } };
  return {
    $cond: [
      { $eq: [x, null] },
      null,
      {
        $cond: [
          isDate,
          x,
          { $cond: [isoShaped, { $convert: { input: x, to: "date", onError: null, onNull: null } }, null] },
        ],
      },
    ],
  };
}

function coerceDateArgMongo(expr: Expr): unknown {
  return compileDateCoerceMongo(compileExpr(expr));
}

function quarterMongo(dateExpr: unknown): unknown {
  return { $add: [{ $floor: { $divide: [{ $subtract: [{ $month: dateExpr }, 1] }, 3] } }, 1] };
}

function switchOnUnitMongo(unit: unknown, branches: Array<[string, unknown]>): unknown {
  return { $switch: { branches: branches.map(([name, then]) => ({ case: { $eq: [unit, name] }, then })), default: null } };
}

function compileDateFnMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  switch (expr.fn) {
    case "year":
    case "month":
    case "day":
    case "hour":
    case "minute":
    case "second": {
      const opMap = {
        year: "$year", month: "$month", day: "$dayOfMonth", hour: "$hour", minute: "$minute", second: "$second",
      } as const;
      return { [opMap[expr.fn]]: coerceDateArgMongo(expr.args[0]!) };
    }
    case "quarter":
      return quarterMongo(coerceDateArgMongo(expr.args[0]!));
    case "weekday":
      return { $isoDayOfWeek: coerceDateArgMongo(expr.args[0]!) };
    case "date_diff": {
      const startC = coerceDateArgMongo(expr.args[0]!);
      const endC = coerceDateArgMongo(expr.args[1]!);
      const unit = compileExpr(expr.args[2]!);
      const msDiff = { $subtract: [endC, startC] };
      const truncDiv = (divisorMs: number) => ({ $trunc: { $divide: [msDiff, divisorMs] } });
      const yearDiff = { $subtract: [{ $year: endC }, { $year: startC }] };
      const monthDiff = {
        $add: [
          { $multiply: [{ $subtract: [{ $year: endC }, { $year: startC }] }, 12] },
          { $subtract: [{ $month: endC }, { $month: startC }] },
        ],
      };
      const body = switchOnUnitMongo(unit, [
        ["year", yearDiff],
        ["month", monthDiff],
        ["day", truncDiv(86400000)],
        ["hour", truncDiv(3600000)],
        ["minute", truncDiv(60000)],
        ["second", truncDiv(1000)],
      ]);
      return { $cond: [{ $or: [{ $eq: [startC, null] }, { $eq: [endC, null] }] }, null, body] };
    }
    case "date_add": {
      const baseC = coerceDateArgMongo(expr.args[0]!);
      const n = compileExpr(expr.args[1]!);
      const unit = compileExpr(expr.args[2]!);
      const formatted = (unitWord: string) => ({
        $dateToString: { date: { $dateAdd: { startDate: baseC, unit: unitWord, amount: n } }, format: "%Y-%m-%dT%H:%M:%SZ" },
      });
      const body = switchOnUnitMongo(unit, [
        ["year", formatted("year")],
        ["month", formatted("month")],
        ["day", formatted("day")],
        ["hour", formatted("hour")],
        ["minute", formatted("minute")],
        ["second", formatted("second")],
      ]);
      return { $cond: [{ $or: [{ $eq: [baseC, null] }, { $eq: [n, null] }] }, null, body] };
    }
    default:
      // Unreachable — callers only route here via DATE_CALL_FNS.has(expr.fn).
      throw new Error(`compileDateFnMongo: unhandled date fn "${expr.fn}"`);
  }
}

const CLEAN_CALL_FNS = new Set([
  "regex_match",
  "regex_extract",
  "regex_replace",
  "canonicalize",
  "strip_accents",
  "parse_date",
  "parse_number",
]);

type DateFormatToken = "YYYY" | "MM" | "DD" | "HH" | "mm" | "ss";
const DATE_FORMAT_TOKENS: DateFormatToken[] = ["YYYY", "MM", "DD", "HH", "mm", "ss"];

/**
 * Compile-time-only translation of batch 6's portable format-token
 * vocabulary into a `^...$` shape-validation regex (digit-class
 * placeholders for tokens, regex-escaped literal separator chars) plus
 * each token's fixed character OFFSET within the matched text — mirrors
 * sqlShared.ts's compileDateFormatSql (self-contained duplicate here, not
 * a cross-file import, matching this file's existing precedent of
 * independently re-deriving each dialect's own construction — see
 * compileToDateMongo vs compileToDateSql). Every portable token has a
 * FIXED width equal to its own length in the format string, so a token's
 * offset in the matched TEXT always equals its offset in the FORMAT
 * STRING itself — no capture groups needed, `$substrCP` at a
 * compile-time-known 0-based offset suffices.
 */
function compileDateFormatShapeMongo(
  format: string,
): { validateRe: string; parts: { token: DateFormatToken; offset: number; width: number }[] } {
  let pattern = "";
  const parts: { token: DateFormatToken; offset: number; width: number }[] = [];
  let i = 0;
  while (i < format.length) {
    const token = DATE_FORMAT_TOKENS.find((t) => format.startsWith(t, i));
    if (token) {
      const width = token === "YYYY" ? 4 : 2;
      pattern += `[0-9]{${width}}`;
      parts.push({ token, offset: i, width });
      i += token.length;
    } else {
      pattern += format[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return { validateRe: `^${pattern}$`, parts };
}

/**
 * Batch 6 (Phase 8b-2) — Cleaning vocabulary, mongo side. Full contract in
 * docs/decisions.md's batch 6 entry and residualEval.ts's evalCleanFn doc
 * comment (the two must stay in agreement); this comment covers only
 * mongo's construction strategy and the genuine capability gaps.
 *
 * - regex_match: native `$regexMatch` directly. NULL-guarded explicitly
 *   (same TEXT_CALL_FNS-doc-comment precedent: mongo string operators do
 *   not reliably null-propagate on their own).
 * - regex_extract: genuinely PUSHABLE on mongo (unlike mysql) via
 *   `$regexFind`, which returns `{match, idx, captures}` (or `null` on no
 *   match) — `captures` is the 0-indexed array of numbered capture
 *   groups, so this grammar's 1-based `group` arg maps to
 *   `captures[group-1]`; `group=0` (whole match) uses `.match` directly.
 *   Bounds-checked against `captures`'s own `$size` before indexing (same
 *   explicit-bounds-check discipline as `split` above), rather than
 *   trusting `$arrayElemAt`'s out-of-range behavior silently.
 * - regex_replace: mongo has NO regex-based replace pipeline operator at
 *   all (only `$replaceOne`/`$replaceAll`, both LITERAL-substring only,
 *   verified against this project's own 7.0.40 sandbox's operator list) —
 *   a genuine capability gap, not a bug. Declared non-pushable on mongo in
 *   FN_PUSHABILITY; throws defensively here, unreachable through the
 *   normal pushdown path (same precedent as `upper`/`lower` above).
 * - canonicalize: declared non-pushable on mongo too — collapsing
 *   INTERNAL whitespace RUNS to a single space has no native operator
 *   without regex-replace (would require a character-by-character
 *   `$reduce` with run-tracking state, a materially riskier/more complex
 *   construction than this batch's other primitives), and mongo has no
 *   regex-replace at all per the point above. Throws defensively.
 * - strip_accents: non-pushable on every dialect (no native NFD-normalize
 *   + combining-mark-strip primitive anywhere in the aggregation
 *   pipeline). Throws defensively.
 * - parse_date: mirrors sqlShared.ts's parse_date exactly in strategy
 *   (compile-time shape-validation regex + compile-time-constant
 *   `$substrCP` offsets, no native date-string parser involved at all,
 *   for the same "avoid an uncertain native-parser ERROR-vs-NULL
 *   divergence" reason) — simpler here since mongo has no bind-param
 *   desync risk, so the extracted digit-text substrings are reused
 *   directly in both the bounds check (via `$toInt`) and the final
 *   `$concat` ISO-8601 assembly, no integer-cast-then-repad round trip
 *   needed.
 * - parse_number: mirrors sqlShared.ts's parse_number (separator
 *   normalization via `$replaceAll`, then the same TRIM+numeric-regex-
 *   match+overflow-guarded `$toDouble` strategy as `coerceNumberMongo`,
 *   reusing the existing `COERCE_NUM_REGEX` constant directly) except
 *   scientific notation is explicitly rejected first, matching
 *   residualEval's same contract.
 */
function compileCleanFnMongo(expr: Extract<Expr, { kind: "call" }>): unknown {
  switch (expr.fn) {
    case "regex_match": {
      const text = compileExpr(expr.args[0]!);
      const pattern = compileExpr(expr.args[1]!);
      const caseInsensitiveArg = expr.args[2];
      const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
      const regexMatch: Record<string, unknown> = { input: text, regex: pattern };
      if (caseInsensitive) regexMatch.options = "i";
      return { $cond: [{ $eq: [text, null] }, null, { $regexMatch: regexMatch }] };
    }
    case "regex_extract": {
      const text = compileExpr(expr.args[0]!);
      const pattern = compileExpr(expr.args[1]!);
      const groupArg = expr.args[2];
      const group =
        groupArg !== undefined && groupArg.kind === "literal" && typeof groupArg.value === "number"
          ? Math.trunc(groupArg.value)
          : 0;
      const found = { $regexFind: { input: text, regex: pattern } };
      const wholeMatch = { $getField: { field: "match", input: found } };
      const captures = { $ifNull: [{ $getField: { field: "captures", input: found } }, []] };
      const selected =
        group === 0
          ? wholeMatch
          : {
              $cond: [
                { $or: [{ $lt: [group, 1] }, { $gt: [group, { $size: captures }] }] },
                null,
                { $arrayElemAt: [captures, group - 1] },
              ],
            };
      return { $cond: [{ $eq: [found, null] }, null, selected] };
    }
    case "regex_replace":
      // Non-pushable on mongo (no native regex-replace pipeline operator)
      // — unreachable through the normal pushdown path;
      // FN_PUSHABILITY.regex_replace.mongo is false (see types.ts). Same
      // defensive-throw precedent as upper/lower above.
      throw new Error(
        `compileCleanFnMongo: "regex_replace" is not pushable on mongo (FN_PUSHABILITY.regex_replace.mongo is false) — this call should have been routed to residual, not compiled`,
      );
    case "canonicalize":
      // Non-pushable on mongo (no regex-replace to collapse internal
      // whitespace runs without a materially riskier $reduce construction)
      // — unreachable through the normal pushdown path;
      // FN_PUSHABILITY.canonicalize.mongo is false (see types.ts).
      throw new Error(
        `compileCleanFnMongo: "canonicalize" is not pushable on mongo (FN_PUSHABILITY.canonicalize.mongo is false) — this call should have been routed to residual, not compiled`,
      );
    case "strip_accents":
      // Non-pushable on every dialect — unreachable through the normal
      // pushdown path; FN_PUSHABILITY.strip_accents.mongo is false.
      throw new Error(
        `compileCleanFnMongo: "strip_accents" is not pushable on mongo (FN_PUSHABILITY.strip_accents.mongo is false) — this call should have been routed to residual, not compiled`,
      );
    case "parse_date": {
      const formatArg = expr.args[1]!;
      if (formatArg.kind !== "literal" || typeof formatArg.value !== "string") {
        // Unreachable — enforced literal by LITERAL_STRING_ARG_INDEXES in expression.ts.
        throw new Error(`compileCleanFnMongo: "parse_date" format argument must be a literal string`);
      }
      const { validateRe, parts } = compileDateFormatShapeMongo(formatArg.value);
      const x = compileExpr(expr.args[0]!);
      const s = { $trim: { input: { $toString: x } } };
      const matches = { $regexMatch: { input: s, regex: validateRe } };
      const defaultPart: Record<DateFormatToken, unknown> = { YYYY: "1970", MM: "01", DD: "01", HH: "00", mm: "00", ss: "00" };
      const partVal: Record<DateFormatToken, unknown> = { ...defaultPart };
      for (const p of parts) partVal[p.token] = { $substrCP: [s, p.offset, p.width] };
      const asInt = (v: unknown) => ({ $toInt: v });
      const boundsOk = {
        $and: [
          { $gte: [asInt(partVal.MM), 1] },
          { $lte: [asInt(partVal.MM), 12] },
          { $gte: [asInt(partVal.DD), 1] },
          { $lte: [asInt(partVal.DD), 31] },
          { $gte: [asInt(partVal.HH), 0] },
          { $lte: [asInt(partVal.HH), 23] },
          { $gte: [asInt(partVal.mm), 0] },
          { $lte: [asInt(partVal.mm), 59] },
          { $gte: [asInt(partVal.ss), 0] },
          { $lte: [asInt(partVal.ss), 59] },
        ],
      };
      const iso = {
        $concat: [partVal.YYYY, "-", partVal.MM, "-", partVal.DD, "T", partVal.HH, ":", partVal.mm, ":", partVal.ss, "Z"],
      };
      return {
        $cond: [
          { $eq: [x, null] },
          null,
          { $cond: [{ $not: [matches] }, null, { $cond: [{ $not: [boundsOk] }, null, iso] }] },
        ],
      };
    }
    case "parse_number": {
      const x = compileExpr(expr.args[0]!);
      const decSep = expr.args[1] !== undefined ? compileExpr(expr.args[1]!) : ".";
      const thousandsSep = { $cond: [{ $eq: [decSep, "."] }, ",", "."] };
      const asTextTrimmed = { $trim: { input: { $toString: x } } };
      const stripped = { $replaceAll: { input: asTextTrimmed, find: thousandsSep, replacement: "" } };
      const normalized = {
        $cond: [{ $eq: [decSep, "."] }, stripped, { $replaceAll: { input: stripped, find: decSep, replacement: "." } }],
      };
      const matches = { $regexMatch: { input: normalized, regex: COERCE_NUM_REGEX } };
      const hasSciNotation = { $regexMatch: { input: { $toLower: normalized }, regex: "e" } };
      const textLen = { $strLenCP: normalized };
      return {
        $cond: [
          { $not: [{ $in: [decSep, [".", ","]] }] },
          null,
          {
            $cond: [
              { $eq: [x, null] },
              null,
              {
                $cond: [
                  hasSciNotation,
                  null,
                  { $cond: [{ $not: [matches] }, null, { $cond: [{ $gt: [textLen, 320] }, null, { $toDouble: normalized }] }] },
                ],
              },
            ],
          },
        ],
      };
    }
    default:
      // Unreachable — callers only route here via CLEAN_CALL_FNS.has(expr.fn).
      throw new Error(`compileCleanFnMongo: unhandled clean fn "${expr.fn}"`);
  }
}

function compileExpr(expr: Expr): unknown {
  switch (expr.kind) {
    case "field":
      return `$${expr.name}`;
    case "literal":
      return expr.value;
    case "binary": {
      const opMap = { "+": "$add", "-": "$subtract", "*": "$multiply", "/": "$divide" } as const;
      return { [opMap[expr.op]]: [compileExpr(expr.left), compileExpr(expr.right)] };
    }
    case "call": {
      if (expr.fn === "concat") return { $concat: expr.args.map(compileExpr) };
      if (expr.fn === "coalesce") return { $ifNull: expr.args.map(compileExpr) };
      if (expr.fn === "contains") {
        const valueArg = expr.args[1]!;
        const pattern = valueArg.kind === "literal" ? escapeRegExp(String(valueArg.value)) : compileExpr(valueArg);
        // Phase 8b-2b: case-SENSITIVE by default; "i" only when the optional 3rd (caseInsensitive) arg is literal `true`.
        const caseInsensitiveArg = expr.args[2];
        const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
        const regexMatch: Record<string, unknown> = { input: compileExpr(expr.args[0]!), regex: pattern };
        if (caseInsensitive) regexMatch.options = "i";
        return { $regexMatch: regexMatch };
      }
      if (expr.fn === "is_null") return { $eq: [compileExpr(expr.args[0]!), null] };
      if (expr.fn === "is_not_null") return { $ne: [compileExpr(expr.args[0]!), null] };
      if (expr.fn === "is_missing_token") {
        // Non-pushable on mongo (FN_PUSHABILITY.is_missing_token.mongo is
        // false — mongo's $toLower is ASCII-only, same divergence as
        // `lower` itself) — this call should always have been routed to
        // residual, never compiled. Defensive throw: unlike sqlShared.ts/
        // residualEval.ts, this function's dispatch chain has no catch-all
        // default at the end (an unmatched fn would otherwise silently
        // fall through to the looks_numeric implementation below).
        throw new Error(
          `compileExpr: "is_missing_token" is not pushable on mongo (FN_PUSHABILITY.is_missing_token.mongo is false) — this call should have been routed to residual, not compiled`,
        );
      }
      if (MATH_CALL_FNS.has(expr.fn)) return compileMathFnMongo(expr);
      if (TEXT_CALL_FNS.has(expr.fn)) return compileTextFnMongo(expr);
      if (COERCION_CALL_FNS.has(expr.fn)) return compileCoercionFnMongo(expr);
      if (DATE_CALL_FNS.has(expr.fn)) return compileDateFnMongo(expr);
      if (CLEAN_CALL_FNS.has(expr.fn)) return compileCleanFnMongo(expr);
      if (expr.fn === "is_number") return { $isNumber: compileExpr(expr.args[0]!) };
      if (expr.fn === "is_text") return { $eq: [{ $type: compileExpr(expr.args[0]!) }, "string"] };
      // looks_numeric (Phase 8b-2b): true JS-number OR a string matching the numeric pattern — content-based, unlike is_number/is_text above.
      const operand = compileExpr(expr.args[0]!);
      return {
        $or: [
          { $isNumber: operand },
          { $and: [{ $eq: [{ $type: operand }, "string"] }, { $regexMatch: { input: operand, regex: "^-?[0-9]+(\\.[0-9]+)?$" } }] },
        ],
      };
    }
    case "comparison": {
      const opMap = { eq: "$eq", neq: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte" } as const;
      return { [opMap[expr.op]]: [compileExpr(expr.left), compileExpr(expr.right)] };
    }
    case "logical": {
      if (expr.op === "not") return compileTriBool(expr);
      const opMap = { and: "$and", or: "$or" } as const;
      return { [opMap[expr.op]]: expr.args.map(compileExpr) };
    }
    case "conditional": {
      const castDateStrings = planDateStringCast([...expr.branches.map((b) => b.then), expr.else]);
      return {
        $switch: {
          branches: expr.branches.map((b) => ({
            case: compileExpr(b.when),
            then: compileConditionalBranch(b.then, castDateStrings),
          })),
          default: compileConditionalBranch(expr.else, castDateStrings),
        },
      };
    }
  }
}

/**
 * Phase 8b-2b (Fix 2): Mongo's native `$not`/comparison operators coerce a
 * NULL operand to a definite boolean (BSON sort-order comparison),
 * diverging from SQL's `NOT NULL = NULL` / "comparison against NULL is
 * NULL/unknown". This makes `not` (and the comparison it wraps) propagate
 * NULL as `null`, matching mysql/postgres/residual — the specific
 * divergence the Phase 8b-2a agreement harness found (case 4:
 * `not(age >= 0)` with a NULL row). Scoped to `comparison` + `not` only;
 * `and`/`or` are left as compileExpr's plain `$and`/`$or` since those
 * weren't found diverging.
 */
function compileTriBool(expr: Expr): unknown {
  if (expr.kind === "comparison") {
    const left = compileExpr(expr.left);
    const right = compileExpr(expr.right);
    const opMap = { eq: "$eq", neq: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte" } as const;
    return {
      $cond: {
        if: { $or: [{ $eq: [left, null] }, { $eq: [right, null] }] },
        then: null,
        else: { [opMap[expr.op]]: [left, right] },
      },
    };
  }
  if (expr.kind === "logical" && expr.op === "not") {
    const operand = compileTriBool(expr.args[0]!);
    return { $cond: { if: { $eq: [operand, null] }, then: null, else: { $not: [operand] } } };
  }
  return compileExpr(expr);
}

/** Bare $group accumulator expression for one AggregationSpec. count_distinct is handled by the aggregate op itself — it needs a $addToSet + $size two-stage sequence, not a single accumulator. */
function compileAggAccumulator(agg: AggregationSpec): unknown {
  const fieldRef = agg.field ? `$${agg.field}` : null;
  switch (agg.fn) {
    case "count":
      return { $sum: 1 };
    case "count_field":
      // Mongo's $ne/$eq treat a missing field and an explicit null equivalently, so this counts only documents where the field is present and non-null — matching SQL's COUNT(col) semantics.
      return { $sum: { $cond: [{ $ne: [fieldRef, null] }, 1, 0] } };
    case "sum":
      return { $sum: fieldRef };
    case "avg":
      return { $avg: fieldRef };
    case "min":
      return { $min: fieldRef };
    case "max":
      return { $max: fieldRef };
    case "count_distinct":
      // Never reached directly — the aggregate op special-cases count_distinct before calling this.
      return { $sum: 0 };
  }
}

function combineAnd(clauses: Record<string, unknown>[]): Record<string, unknown> | null {
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0]!;
  return { $and: clauses };
}

export const mongoAdapter: MongoDialectAdapter = {
  dialect: "mongo",
  compileExpr,
  compileCondition,
  compileAggAccumulator,
  combineAnd,
};
