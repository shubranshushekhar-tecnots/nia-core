import type { Expr } from "../expression.js";
import { MISSING_VALUE_TOKENS } from "../profile.js";

/**
 * Generic per-row evaluation helper shared by multiple ops' `applyResidual`
 * (filter's `expr`, computed_field's `expression`, aggregate's `having`) —
 * not dialect-specific, so this lives here rather than on any
 * DialectAdapter. The field/literal/binary/call cases are ported verbatim
 * from the pre-refactor residualTransform.ts; the comparison/logical/
 * conditional cases (Phase 8b-1) fold in what used to be the standalone
 * `matchesCondition` (deleted — its per-operator logic is reproduced here
 * exactly, now reachable through any position in an Expr tree instead of
 * only a flat FilterCondition).
 *
 * Three-valued (SQL-style) NULL logic as of Phase 8b-2b: `comparison`
 * yields `null` (not a coerced boolean) when either operand is null/
 * undefined, and `logical` and/or/not follow the standard SQL truth
 * tables (`and`: false dominates, else null dominates, else true; `or`:
 * true dominates, else null dominates, else false; `not null = null`).
 * This makes the residual path agree with mysql/postgres/mongo's own
 * NULL semantics instead of JS-coercing (`Number(null) === 0`, so
 * `null > -1` used to evaluate `true` here — that was the bug Phase
 * 8b-2a's three-way agreement harness caught: when three independent
 * implementations agree and this one doesn't, this one is wrong, not a
 * "disclosed divergence"). `conditional`'s branch test already used
 * `Boolean(...)`, which correctly treats a `null` condition as
 * non-matching (SQL `CASE WHEN NULL THEN ...` skips the branch) — no
 * change needed there.
 */
/** "Looks like a number" — content-based, regardless of the value's actual JS type (e.g. the string "123" matches). Backs `looks_numeric` only, per Phase 8b-2b; `is_number`/`is_text` use true-type checks below, matching Mongo's `$isNumber`/`$type`. */
const NUMBER_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;
function looksNumeric(v: unknown): boolean {
  return typeof v === "number" || (typeof v === "string" && NUMBER_PATTERN.test(v));
}

/**
 * Phase 8b-2, batch 0 (Fix 2): type-aware ordering comparator for
 * gt/gte/lt/lte. Previously both operands were unconditionally coerced via
 * `Number(...)` before comparing — correct for numeric operands, but
 * silently wrong for strings (`Number("a")` is `NaN`, so every ordering
 * comparison between two non-numeric strings evaluated to `false`,
 * regardless of operator or operand — found via the widened collation
 * probe: mysql/postgres/mongo all order strings byte-wise/lexicographically
 * while residual matched literally none of them). String-vs-string now
 * compares lexicographically via JS's native `<`/`>` (UTF-16 code-unit
 * order, which matches byte-wise ASCII ordering for the plain-ASCII data
 * these ops are exercised against) — the same ordering postgres/mongo's
 * default byte-wise comparison and mysql's Fix-1 BINARY-forced comparison
 * now produce. Anything else falls back to the original Number(...)
 * coercion, unchanged.
 */
function compareOrdered(left: unknown, right: unknown): number {
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const a = Number(left);
  const b = Number(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * STANDING RULE (Loose end 3, Phase 8b-2, batch 0 — not a one-off fix):
 * this file has now shipped two bugs with the identical root cause —
 * `Number(null) === 0` (Phase 8b-2a's three-way agreement harness caught a
 * stale `null > -1` evaluating `true`; see the file-header comment above)
 * and `Number("a") === NaN` (compareOrdered's own fix, above). Both came
 * from defaulting to bare JS coercion (`Number(...)`, or a bare `</`/`>`)
 * for a COMPARISON between two typed values. JS coercion is the wrong
 * default there: it silently reinterprets non-numeric operands instead of
 * comparing them as their actual type, and every divergence it's produced
 * so far turned out to be a genuine bug (this evaluator disagreeing with
 * all three DB-backed evaluators), never a legitimate residual-specific
 * semantic. The rule going forward, binding for batch 1 onward (~49 new
 * call-fns landing): any new op/function that COMPARES two values here
 * (ordering, equality, or a comparison-shaped predicate) must route
 * through an explicit typed path — extend `compareOrdered` or add a
 * sibling typed comparator — never a bare `Number(...)` coercion or a raw
 * JS relational operator (`<`, `>`, `===`) applied directly to two
 * `unknown`-typed operands. This does NOT apply to plain ARITHMETIC
 * (`binary`'s +, -, *, / case below, and batch 1's math functions): those
 * operations are inherently numeric by definition — `Number(...)`
 * coercion there is the correct, intended semantic, not a shortcut around
 * typing. The distinction is comparison (needs the operand's real type)
 * vs. arithmetic (numeric is the type).
 */

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
 * Batch 1 (Phase 8b-2) — DAX-derived Math core, residual arm. Mirrors
 * sqlShared.ts's compileMathFnSql / mongo.ts's compileMathFnMongo exactly
 * (same divide-by-zero contract, same DAX divisor-sign `mod`, same
 * sign/floor/ceil/abs-built round family, same int-floors-vs-trunc-
 * truncates distinction) so all 4 evaluators agree by construction, not
 * by coincidence. `Number(...)` coercion here is the STANDING RULE's
 * declared-correct case (arithmetic, not comparison — see the doc
 * comment above) — but unlike plain `binary` arithmetic (which coerces
 * `null` to `0`), every math fn here explicitly propagates a null/
 * undefined operand to `null` first, matching what the native SQL/Mongo
 * primitives these compile down to already do (e.g. `ABS(NULL)` = NULL
 * on every dialect) — this is a call-fn-specific null-handling decision,
 * not a relaxation of the standing rule.
 */
function evalMathFn(expr: Extract<Expr, { kind: "call" }>, row: Record<string, unknown>): unknown {
  const raw = (i: number): unknown => evalExpr(expr.args[i]!, row);
  const num = (i: number): number | null => {
    const v = raw(i);
    return v === null || v === undefined ? null : Number(v);
  };
  switch (expr.fn) {
    case "abs": {
      const x = num(0);
      return x === null ? null : Math.abs(x);
    }
    case "ceil": {
      const x = num(0);
      return x === null ? null : Math.ceil(x);
    }
    case "floor":
    case "int": {
      const x = num(0);
      return x === null ? null : Math.floor(x);
    }
    case "sign": {
      const x = num(0);
      return x === null ? null : Math.sign(x);
    }
    case "sqrt": {
      const x = num(0);
      if (x === null) return null;
      return x < 0 ? null : Math.sqrt(x);
    }
    case "trunc": {
      const x = num(0);
      return x === null ? null : Math.trunc(x);
    }
    case "power": {
      const base = num(0);
      const exponent = num(1);
      return base === null || exponent === null ? null : Math.pow(base, exponent);
    }
    case "divide": {
      const n = num(0);
      const d = num(1);
      if (n === null || d === null) return null;
      if (d === 0) return expr.args[2] !== undefined ? raw(2) : null;
      return n / d;
    }
    case "mod": {
      const n = num(0);
      const d = num(1);
      if (n === null || d === null) return null;
      if (d === 0) return null;
      return n - d * Math.floor(n / d);
    }
    case "quotient": {
      const n = num(0);
      const d = num(1);
      if (n === null || d === null) return null;
      if (d === 0) return null;
      return Math.trunc(n / d);
    }
    case "round":
    case "round_up":
    case "round_down": {
      const x = num(0);
      if (x === null) return null;
      const digits = expr.args[1] !== undefined ? num(1) : 0;
      if (digits === null) return null;
      const scale = Math.pow(10, digits);
      const magnitude = Math.abs(x) * scale;
      if (expr.fn === "round_down") return (Math.sign(x) * Math.floor(magnitude)) / scale;
      if (expr.fn === "round_up") return (Math.sign(x) * Math.ceil(magnitude)) / scale;
      return (Math.sign(x) * Math.floor(magnitude + 0.5)) / scale;
    }
    case "round_to_multiple": {
      const x = num(0);
      const m = num(1);
      if (x === null || m === null) return null;
      if (m === 0) return 0;
      const absM = Math.abs(m);
      return Math.sign(x) * Math.floor(Math.abs(x) / absM + 0.5) * absM;
    }
    // Batch 2 (Phase 8b-2) — exp|ln|log. Contract mirrors sqlShared.ts's
    // batch 2 doc comment (ln(x)/log(x) x<=0 -> null; log(x,base)
    // additionally base<=0 or base=1 -> null): Math.log(0) is -Infinity
    // and Math.log(negative) is NaN natively in JS, neither of which
    // matches the pinned NULL contract, so both are explicitly guarded
    // here rather than left to fall out of Math.log's real behavior.
    case "exp": {
      const x = num(0);
      return x === null ? null : Math.exp(x);
    }
    case "ln": {
      const x = num(0);
      if (x === null) return null;
      return x <= 0 ? null : Math.log(x);
    }
    case "log": {
      const x = num(0);
      if (x === null) return null;
      if (expr.args[1] === undefined) return x <= 0 ? null : Math.log(x);
      const base = num(1);
      if (base === null) return null;
      if (x <= 0 || base <= 0 || base === 1) return null;
      return Math.log(x) / Math.log(base);
    }
    default:
      // Unreachable — callers only route here via MATH_CALL_FNS.has(expr.fn).
      throw new Error(`evalMathFn: unhandled math fn "${expr.fn}"`);
  }
}

const TEXT_CALL_FNS = new Set([
  "upper",
  "lower",
  "trim",
  "left",
  "right",
  "mid",
  "len",
  "substitute",
  "find",
  "rept",
  "split",
]);

/**
 * Batch 3 (Phase 8b-2) — DAX-derived Text-core vocabulary, residual arm.
 * Mirrors sqlShared.ts's compileTextFnSql / mongo.ts's compileTextFnMongo
 * contract-for-contract (see that doc comment for the full live-verified
 * reasoning); this file only notes what's residual/JS-specific:
 *
 * - "character" = Unicode CODE POINT throughout (matches mysql/postgres's
 *   CHAR_LENGTH and mongo's $strLenCP/$substrCP/$indexOfCP, all verified
 *   live to agree). JS strings are UTF-16 internally, so native
 *   `.length`/`.indexOf`/`.slice` are WRONG for len/find/left/right/mid
 *   whenever an astral character (most emoji) is present — they'd split a
 *   surrogate pair. `Array.from(str)` iterates by code point (the string
 *   iterator protocol is surrogate-pair-aware), so every code-point-
 *   sensitive op here works off that array, never the raw string.
 * - trim strips ASCII whitespace ONLY (space/tab/LF/VT/FF/CR), never
 *   native `.trim()` — JS's `.trim()` strips a much broader Unicode
 *   whitespace set (e.g. NBSP), which would diverge from the pinned
 *   ASCII-only contract mysql/postgres's REGEXP_REPLACE and mongo's
 *   explicit `chars`-pinned $trim already enforce.
 * - substitute explicitly guards an empty search string and returns the
 *   text unchanged — JS's native `"abc".replaceAll("", "X")` inserts "X"
 *   between every character (same divergent behavior proven live on
 *   mongo's $replaceAll), so this must never be allowed to reach the
 *   native replaceAll call.
 * - find is case-sensitive by default (opts into case-insensitive only via
 *   a literal-`true` 3rd arg, same convention as `contains`), 1-based,
 *   code-point-based, 0 when not found, and returns 1 for an empty needle
 *   (verified live to already be mysql/postgres's native behavior with no
 *   guard needed — kept here for parity, not because JS needs a guard).
 * - left/right/mid all clamp their numeric args via `Math.max(...,0)` (or
 *   `Math.max(...,1)` for mid's 1-based start) BEFORE using them —
 *   mirrors the explicit clamps sqlShared.ts's left/right/mid apply to
 *   override mysql/postgres's mutually-incompatible native negative-n/
 *   negative-start behaviors (verified live via LEFT('hello',-1) —
 *   mysql: '', postgres: 'hell' — and SUBSTRING's start<=0 divergence).
 * - rept clamps its count to [0, 1000] before calling `.repeat()` — same
 *   defensive ceiling as sqlShared.ts/mongo.ts's rept (disclosed
 *   simplification, not tied to any DAX/Excel-specific limit; required on
 *   mongo since it has no native repeat-string primitive at all).
 * - split's delimiter match is a literal substring split (JS's
 *   `String.prototype.split(str)` with a plain string arg is literal, not
 *   regex) — matches every other dialect's non-regex delimiter semantics.
 *   Empty delimiter or an out-of-[1,partCount] index both explicitly
 *   return null, mirroring the CASE/$cond guards on the other 3
 *   evaluators (mongo's $split throws on an empty separator; here it
 *   would just silently return one part per character, an equally wrong
 *   but non-crashing divergence — guarded explicitly rather than relied
 *   upon either way).
 *
 * Non-null/non-undefined operands are coerced via `String(v)` before any
 * string op runs (mirrors evalMathFn's `Number(v)` coercion for the same
 * reason: these ops are inherently string-typed by definition, so a
 * type-coercing default is the correct, intended semantic here — not a
 * violation of the STANDING RULE above, which only binds *comparisons*).
 */
function evalTextFn(expr: Extract<Expr, { kind: "call" }>, row: Record<string, unknown>): unknown {
  const raw = (i: number): unknown => evalExpr(expr.args[i]!, row);
  const str = (i: number): string | null => {
    const v = raw(i);
    return v === null || v === undefined ? null : String(v);
  };
  const num = (i: number): number | null => {
    const v = raw(i);
    return v === null || v === undefined ? null : Number(v);
  };
  switch (expr.fn) {
    case "upper": {
      const x = str(0);
      return x === null ? null : x.toUpperCase();
    }
    case "lower": {
      const x = str(0);
      return x === null ? null : x.toLowerCase();
    }
    case "trim": {
      const x = str(0);
      if (x === null) return null;
      return x.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
    }
    case "len": {
      const x = str(0);
      return x === null ? null : Array.from(x).length;
    }
    case "left": {
      const x = str(0);
      const n = num(1);
      if (x === null || n === null) return null;
      const cp = Array.from(x);
      const take = Math.max(Math.trunc(n), 0);
      return cp.slice(0, take).join("");
    }
    case "right": {
      const x = str(0);
      const n = num(1);
      if (x === null || n === null) return null;
      const cp = Array.from(x);
      const take = Math.max(Math.trunc(n), 0);
      const start = Math.max(cp.length - take, 0);
      return cp.slice(start).join("");
    }
    case "mid": {
      const x = str(0);
      const startArg = num(1);
      const nArg = num(2);
      if (x === null || startArg === null || nArg === null) return null;
      const cp = Array.from(x);
      const start1 = Math.max(Math.trunc(startArg), 1);
      const n = Math.max(Math.trunc(nArg), 0);
      const startIdx = start1 - 1;
      return cp.slice(startIdx, startIdx + n).join("");
    }
    case "substitute": {
      const x = str(0);
      const search = str(1);
      const replacement = str(2);
      if (x === null || search === null || replacement === null) return null;
      if (search === "") return x;
      return x.split(search).join(replacement);
    }
    case "find": {
      const needleRaw = str(0);
      const haystackRaw = str(1);
      if (needleRaw === null || haystackRaw === null) return null;
      const caseInsensitiveArg = expr.args[2];
      const caseInsensitive = caseInsensitiveArg !== undefined && evalExpr(caseInsensitiveArg, row) === true;
      const needle = caseInsensitive ? needleRaw.toLowerCase() : needleRaw;
      const haystack = caseInsensitive ? haystackRaw.toLowerCase() : haystackRaw;
      if (needle === "") return 1;
      const hcp = Array.from(haystack);
      const ncp = Array.from(needle);
      for (let i = 0; i <= hcp.length - ncp.length; i++) {
        let match = true;
        for (let j = 0; j < ncp.length; j++) {
          if (hcp[i + j] !== ncp[j]) {
            match = false;
            break;
          }
        }
        if (match) return i + 1;
      }
      return 0;
    }
    case "rept": {
      const x = str(0);
      const nArg = num(1);
      if (x === null || nArg === null) return null;
      const n = Math.min(Math.max(Math.trunc(nArg), 0), 1000);
      return x.repeat(n);
    }
    case "split": {
      const x = str(0);
      const delim = str(1);
      const idxArg = num(2);
      if (x === null || delim === null || idxArg === null) return null;
      const index = Math.trunc(idxArg);
      if (delim === "" || index < 1) return null;
      const parts = x.split(delim);
      if (index > parts.length) return null;
      return parts[index - 1];
    }
    default:
      // Unreachable — callers only route here via TEXT_CALL_FNS.has(expr.fn).
      throw new Error(`evalTextFn: unhandled text fn "${expr.fn}"`);
  }
}

const COERCION_CALL_FNS = new Set([
  "to_number",
  "to_integer",
  "to_text",
  "format_number",
  "to_boolean",
  "to_date",
  "to_timestamp",
]);

/**
 * Batch 4 (Phase 8b-2) — Coercion vocabulary, residual arm. Contracts
 * pinned in docs/decisions.md's batch 4 entry; summarized here:
 *  - to_number(x)/to_integer(x): NULL/boolean -> null. A string must match
 *    COERCE_NUMBER_PATTERN (optional sign, digits, optional scientific
 *    notation with a bounded exponent) or -> null; a non-finite parse
 *    (overflow) -> null. to_integer truncates TOWARD ZERO afterward
 *    (matches batch-1 trunc/int's toward-zero vs toward-negative-infinity
 *    distinction — to_integer is toward-zero, same as `trunc`).
 *  - to_text(x): NULL -> null; string passthrough; boolean -> 'true'/
 *    'false'; number -> formatDecimal(x, null) (round-half-away-from-zero
 *    to 6 fractional digits, trailing zeros stripped) — a deliberately
 *    OWN digit-construction algorithm, not native String(x)/toFixed,
 *    because native number->text formatting diverges across mysql/
 *    postgres/mongo/JS at large-magnitude/scientific-notation boundaries
 *    (verified live) and native toFixed's rounding mode isn't guaranteed
 *    tie-away-from-zero either.
 *  - format_number(value, decimals): same formatDecimal machinery but
 *    decimals is REQUIRED, clamped to [0,10], and fractional digits are
 *    zero-padded (never stripped) — locale-invariant (plain '.' decimal
 *    point, no thousands separator). value goes through the same
 *    coerceToNumber gate as to_number (so a non-numeric string/boolean
 *    input -> null, not a thrown error).
 *  - to_boolean(x): NULL -> null; boolean passthrough; number: exactly
 *    1 -> true, exactly 0 -> false, else null; string: trim +
 *    case-insensitive 'true'/'1' -> true, 'false'/'0' -> false, else
 *    null.
 *  - to_date(x): NULL -> null. A real `Date` instance (pg/mysql2/mongodb
 *    all deserialize a typed date/timestamp column into one before this
 *    fn ever sees it — same as coerceToDate below) normalizes via its UTC
 *    fields, never rejected. A string goes through the ISO-8601-only fast
 *    path (`YYYY-MM-DD` optionally followed by `T`/space + `HH:MM[:SS]`,
 *    optionally `Z`-suffixed) with basic calendar-bounds checking
 *    (month 1-12, day 1-31, hour<=23, minute/second<=59 — NOT full
 *    days-in-month/leap-year validation, a disclosed simplification).
 *    Any other type, or non-ISO string input -> null (never throws).
 *    Explicit numeric UTC offsets (e.g. +05:00) are NOT matched by the
 *    string pattern -> null: applying the UTC pin via pure offset
 *    arithmetic was judged out of scope for a pure regex+reassembly
 *    implementation (no native date-parsing primitive is used anywhere in
 *    this fn, on any of the 4 evaluators, by design) — a disclosed
 *    limitation, not a bug. Output is always normalized to
 *    `YYYY-MM-DDTHH:MM:SSZ`.
 */
const COERCE_NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,4})?$/;

function coerceToNumber(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!COERCE_NUMBER_PATTERN.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** decimals=null: up to 6 fractional digits, trailing zeros stripped (to_text). decimals=N: exactly N digits, zero-padded, never stripped (format_number). Round-half-away-from-zero (same tie-break convention as batch 1's round()). */
function formatDecimal(x: number, decimals: number | null): string {
  const d = decimals === null ? 6 : decimals;
  const scale = Math.pow(10, d);
  const scaled = Math.floor(Math.abs(x) * scale + 0.5);
  const intPart = Math.floor(scaled / scale);
  const fracPart = scaled - intPart * scale;
  const sign = x < 0 && scaled !== 0 ? "-" : "";
  let fracStr = d === 0 ? "" : String(fracPart).padStart(d, "0");
  if (decimals === null) fracStr = fracStr.replace(/0+$/, "");
  return sign + String(intPart) + (fracStr ? "." + fracStr : "");
}

// Seconds are REQUIRED whenever a time-of-day is present (mirrors
// sqlShared.ts's compileToDateSql — only 2 fixed-width shapes accepted,
// so SQL can extract every field via a constant-position SUBSTRING with
// no capture-group-extraction primitive; HH:MM-without-seconds and
// fractional seconds/explicit UTC offsets are deliberately NOT matched).
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?Z?$/;

function normalizeIsoDate(s: string): string | null {
  const m = ISO_DATE_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = h !== undefined ? Number(h) : 0;
  const min = mi !== undefined ? Number(mi) : 0;
  const sec = se !== undefined ? Number(se) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) return null;
  return `${y}-${mo}-${d}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}Z`;
}

// Bug fix (all-rows-quarantined): dedicated timestamp regex/normalizer for
// `to_timestamp`, separate from ISO_DATE_RE/normalizeIsoDate above so
// `to_date`'s existing fixed-width contract (many callers/tests already
// pin its exact "no fractional seconds" output shape) is never touched.
// Differs from ISO_DATE_RE only in accepting an optional `.fff` fractional-
// seconds group (1-6 digits, truncated/padded to milliseconds) — the gap
// that caused a real Date's/timestamptz's millisecond-precision ISO string
// (e.g. `2026-09-22T10:09:40.918Z`) to fail to parse and quarantine every
// row of an otherwise-clean copy.
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?Z?$/;

function normalizeIsoTimestamp(s: string): string | null {
  const m = ISO_TIMESTAMP_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = h !== undefined ? Number(h) : 0;
  const min = mi !== undefined ? Number(mi) : 0;
  const sec = se !== undefined ? Number(se) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) return null;
  const ms = frac !== undefined ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  const base = `${y}-${mo}-${d}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return ms === 0 ? `${base}Z` : `${base}.${String(ms).padStart(3, "0")}Z`;
}

function evalCoercionFn(expr: Extract<Expr, { kind: "call" }>, row: Record<string, unknown>): unknown {
  const raw = (i: number): unknown => evalExpr(expr.args[i]!, row);
  switch (expr.fn) {
    case "to_number":
      return coerceToNumber(raw(0));
    case "to_integer": {
      const n = coerceToNumber(raw(0));
      return n === null ? null : Math.trunc(n);
    }
    case "to_text": {
      const v = raw(0);
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "number") return Number.isFinite(v) ? formatDecimal(v, null) : null;
      return String(v);
    }
    case "format_number": {
      const n = coerceToNumber(raw(0));
      const decRaw = coerceToNumber(raw(1));
      if (n === null || decRaw === null) return null;
      const decimals = Math.min(Math.max(Math.trunc(decRaw), 0), 10);
      return formatDecimal(n, decimals);
    }
    case "to_boolean": {
      const v = raw(0);
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0") return false;
        return null;
      }
      return null;
    }
    case "to_date": {
      const v = raw(0);
      if (v === null || v === undefined) return null;
      // Bug fix: pg/mysql2/mongodb all deserialize a real date/timestamp
      // column into a genuine JS `Date` before residualEval ever sees it
      // (see coerceToDate's doc comment above, which already handles this
      // for the date-part fns) — this case used to reject any non-string
      // input outright, so the schema-layer runtime conformance cast
      // (conformance.ts, which casts every mapped date/timestamp column on
      // every write) treated every non-null Date value as a coercion
      // failure, quarantining every row of any plain copy with a date
      // column. Normalize a real Date the same way normalizeIsoDate
      // normalizes a matching string, instead of bailing.
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null;
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}Z`;
      }
      if (typeof v !== "string") return null;
      return normalizeIsoDate(v);
    }
    case "to_timestamp": {
      const v = raw(0);
      if (v === null || v === undefined) return null;
      // Same Date-instance handling as to_date's case above, but preserves
      // millisecond precision instead of truncating it — this is the
      // conversion ops/conformance.ts now uses for `timestamp`-kind
      // columns (see conformance.ts's CONFORMANCE_CAST_FN), since a real
      // timestamptz/timestamp value's fidelity includes sub-second
      // precision that to_date's fixed-width output silently drops.
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return null;
        const pad = (n: number) => String(n).padStart(2, "0");
        const base = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
        const ms = v.getUTCMilliseconds();
        return ms === 0 ? `${base}Z` : `${base}.${String(ms).padStart(3, "0")}Z`;
      }
      if (typeof v !== "string") return null;
      return normalizeIsoTimestamp(v);
    }
    default:
      // Unreachable — callers only route here via COERCION_CALL_FNS.has(expr.fn).
      throw new Error(`evalCoercionFn: unhandled coercion fn "${expr.fn}"`);
  }
}

const DATE_CALL_FNS = new Set([
  "year", "month", "day", "hour", "minute", "second", "quarter", "weekday", "date_diff", "date_add",
]);

/**
 * Phase 8b-2, batch 5 — Date-part vocabulary, residual (in-memory JS)
 * arm. Full contract in docs/decisions.md's batch 5 entry (shared across
 * all 3 dialects); this comment covers only what's specific to this
 * evaluator.
 *
 * Unlike sqlShared.ts/mongo.ts (which compile an expression tree into a
 * query the DB engine later executes against its own typed columns),
 * this evaluator runs directly against real driver-deserialized row
 * values: postgres (pg)/mysql2/mongodb all deserialize a typed date/
 * timestamp column into a genuine JS `Date` instance before
 * residualEval ever sees it, and this package has no schema/column-type
 * visibility to know in advance when a `field` result will be one — so
 * `coerceToDate` below must handle BOTH a real `Date` and an ISO-8601
 * string, where sqlShared.ts/mongo.ts's coercion only had to reason
 * about "real column vs. text" at the SQL/pipeline-construction level.
 * Reuses ISO_DATE_RE (already defined above for to_date) so leniency
 * matches to_date's already-shipped contract exactly, and interprets
 * every string as UTC (Date.UTC, never a local-timezone constructor)
 * matching this batch's UTC-everywhere pin.
 *
 * date_add's month/year clamp is hand-rolled here (addMonthsClamped),
 * unlike sqlShared.ts/mongo.ts which delegate to each engine's native
 * interval arithmetic (confirmed live to clamp already) — this
 * evaluator has no native date-arithmetic primitive to delegate to (by
 * the same "no native date-parsing primitive anywhere in this fn"
 * design constraint documented on to_date above), so the clamp-to-last-
 * valid-day behavior needed for cross-evaluator contract consistency is
 * implemented directly via a days-in-month lookup (`daysInMonth`).
 */
function coerceToDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string") return null;
  const m = ISO_DATE_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h !== undefined ? Number(h) : 0;
  const min = mi !== undefined ? Number(mi) : 0;
  const sec = se !== undefined ? Number(se) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
}

function isoFromDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

/** getUTCDay(): 0=Sun..6=Sat -> ISO numbering 1=Mon..7=Sun. */
function isoWeekday(d: Date): number {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** month1to12 is 1-based (Jan=1); Date.UTC(year, month1to12, 0) lands on day 0 of the following 0-based month, i.e. the last day of month1to12 itself. */
function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Adds `totalMonths` (may be negative) to `d`, clamping the resulting day-of-month to the target month's last valid day — matches sqlShared.ts/mongo.ts's native-interval-arithmetic clamp behavior (confirmed live, see month-add-clamp-probe.ts). Time-of-day is preserved unchanged. */
function addMonthsClamped(d: Date, totalMonths: number): Date {
  const totalIndex = d.getUTCFullYear() * 12 + d.getUTCMonth() + totalMonths;
  const newYear = Math.floor(totalIndex / 12);
  const newMonth0 = ((totalIndex % 12) + 12) % 12;
  const clampedDay = Math.min(d.getUTCDate(), daysInMonth(newYear, newMonth0 + 1));
  return new Date(Date.UTC(newYear, newMonth0, clampedDay, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

function evalDateFn(expr: Extract<Expr, { kind: "call" }>, row: Record<string, unknown>): unknown {
  const raw = (i: number): unknown => evalExpr(expr.args[i]!, row);
  switch (expr.fn) {
    case "year": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCFullYear();
    }
    case "month": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCMonth() + 1;
    }
    case "day": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCDate();
    }
    case "hour": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCHours();
    }
    case "minute": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCMinutes();
    }
    case "second": {
      const d = coerceToDate(raw(0));
      return d === null ? null : d.getUTCSeconds();
    }
    case "quarter": {
      const d = coerceToDate(raw(0));
      return d === null ? null : Math.floor(d.getUTCMonth() / 3) + 1;
    }
    case "weekday": {
      const d = coerceToDate(raw(0));
      return d === null ? null : isoWeekday(d);
    }
    case "date_diff": {
      const start = coerceToDate(raw(0));
      const end = coerceToDate(raw(1));
      const unit = raw(2);
      if (start === null || end === null || typeof unit !== "string") return null;
      if (unit === "year") return end.getUTCFullYear() - start.getUTCFullYear();
      if (unit === "month") {
        return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
      }
      const diffMs = end.getTime() - start.getTime();
      if (unit === "day") return Math.trunc(diffMs / 86400000);
      if (unit === "hour") return Math.trunc(diffMs / 3600000);
      if (unit === "minute") return Math.trunc(diffMs / 60000);
      if (unit === "second") return Math.trunc(diffMs / 1000);
      return null;
    }
    case "date_add": {
      const base = coerceToDate(raw(0));
      const n = coerceToNumber(raw(1));
      const unit = raw(2);
      if (base === null || n === null || typeof unit !== "string") return null;
      if (unit === "year") return isoFromDate(addMonthsClamped(base, Math.trunc(n) * 12));
      if (unit === "month") return isoFromDate(addMonthsClamped(base, Math.trunc(n)));
      if (unit === "day") return isoFromDate(new Date(base.getTime() + n * 86400000));
      if (unit === "hour") return isoFromDate(new Date(base.getTime() + n * 3600000));
      if (unit === "minute") return isoFromDate(new Date(base.getTime() + n * 60000));
      if (unit === "second") return isoFromDate(new Date(base.getTime() + n * 1000));
      return null;
    }
    default:
      // Unreachable — callers only route here via DATE_CALL_FNS.has(expr.fn).
      throw new Error(`evalDateFn: unhandled date fn "${expr.fn}"`);
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

/**
 * Phase 8b-2, batch 6 — Cleaning vocabulary, residual (in-memory JS) arm.
 * Full contract in docs/decisions.md's batch 6 entry; summarized here:
 *
 * - regex_match(text, pattern, [caseInsensitive]) -> boolean|null. NULL-
 *   propagates on a null/undefined `text` (deliberately NOT joined into
 *   BOOLEAN_CALL_FNS above, diverging from `contains`'s always-false-for-
 *   non-string precedent — a regex match against a genuinely absent value
 *   is "unknown", not "false"). Case-SENSITIVE by default; the optional
 *   3rd arg opts into case-insensitive, same convention as `contains`/
 *   `find`. `pattern` is enforced literal at parse time (walkWellFormed's
 *   LITERAL_STRING_ARG_INDEXES in expression.ts) — an invalid regex
 *   literal is a workflow-author authoring mistake, not row data, so it's
 *   allowed to throw here (loud, at first evaluation) rather than being
 *   swallowed to null.
 * - regex_extract(text, pattern, [group=0]) -> text|null. group=0 (the
 *   default) is the whole match; group>=1 selects a capture group.
 *   Non-matching pattern, or a requested group the pattern doesn't have
 *   (undefined capture) -> null.
 * - regex_replace(text, pattern, replacement, [caseInsensitive]) ->
 *   text|null, replaces ALL matches (global), consistent with
 *   `substitute`'s existing global-replace contract. `replacement` uses
 *   mysql/postgres-native `\1`-`\9` backreference syntax (enforced literal
 *   at parse time, same as `pattern`) — translated to JS's `$1`-`$9`
 *   syntax via `translateBackreferences` before calling the native
 *   `.replace()`, and any literal `$` in the replacement text is escaped
 *   first so it survives untouched (JS's replace() otherwise treats bare
 *   `$` sequences specially).
 * - canonicalize(text) -> text|null. Collapses internal ASCII-whitespace
 *   runs to a single space and trims both ends, reusing the EXACT SAME
 *   ASCII-only whitespace set as batch 3's `trim` (space/tab/LF/VT/FF/CR)
 *   — deliberately not diverging from that pin.
 * - strip_accents(text) -> text|null. NFD-normalizes then strips the
 *   Unicode combining-marks block (U+0300-U+036F). Disclosed limitation
 *   (same on all 4 evaluators): this also strips non-diacritic combining
 *   marks in non-Latin scripts (e.g. Hebrew niqqud, Arabic tashkeel) — a
 *   blind strip, not a language-aware one.
 * - parse_date(text, format) -> ISO-8601 `YYYY-MM-DDTHH:MM:SSZ`|null.
 *   `format` is a small portable token vocabulary (YYYY/MM/DD/HH/mm/ss +
 *   literal separator characters matched exactly, enforced literal at
 *   parse time), translated here into a matching regex
 *   (`compileDateFormatToRegex`); non-matching text or an out-of-range
 *   calendar field -> null (same basic-bounds checking as `to_date`'s
 *   `normalizeIsoDate`, not full days-in-month/leap-year validation).
 *   Output uses the same ISO-8601 shape `coerceToDate` above already
 *   parses, so `year(parse_date(...))` etc. compose directly.
 * - parse_number(text, [decimalSeparator="."]) -> number|null. The
 *   opposite character from `decimalSeparator` is always treated as a
 *   thousands separator and stripped (default: "," stripped, "." is
 *   decimal; decimalSeparator="," flips this). Only "." and ","  are
 *   accepted as `decimalSeparator` values -> anything else is null. After
 *   normalizing to a plain "."-decimal string, delegates to the exact
 *   same `coerceToNumber` machinery `to_number` uses — EXCEPT scientific
 *   notation is explicitly rejected first (disclosed scope-narrowing vs.
 *   `to_number`, to avoid ambiguity with locale-formatted numbers that
 *   happen to contain a bare "e"/"E").  An already-numeric `text` input
 *   passes through `coerceToNumber`-style finite-check directly, skipping
 *   separator normalization (nothing to normalize).
 */
function translateBackreferences(replacement: string): string {
  return replacement.replace(/\$/g, "$$$$").replace(/\\([1-9])/g, "$$$1");
}

type DateFormatToken = "YYYY" | "MM" | "DD" | "HH" | "mm" | "ss";
const DATE_FORMAT_TOKENS: DateFormatToken[] = ["YYYY", "MM", "DD", "HH", "mm", "ss"];

/** Translates the batch 6 portable format-token vocabulary into a matching regex, in token-occurrence order (so extracted capture groups can be mapped back to their field). */
function compileDateFormatToRegex(format: string): { re: RegExp; tokenOrder: DateFormatToken[] } {
  let pattern = "";
  const tokenOrder: DateFormatToken[] = [];
  let i = 0;
  while (i < format.length) {
    const token = DATE_FORMAT_TOKENS.find((t) => format.startsWith(t, i));
    if (token) {
      const width = token === "YYYY" ? 4 : 2;
      pattern += `(\\d{${width}})`;
      tokenOrder.push(token);
      i += token.length;
    } else {
      pattern += format[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return { re: new RegExp(`^${pattern}$`), tokenOrder };
}

function evalCleanFn(expr: Extract<Expr, { kind: "call" }>, row: Record<string, unknown>): unknown {
  const raw = (i: number): unknown => evalExpr(expr.args[i]!, row);
  const str = (i: number): string | null => {
    const v = raw(i);
    return v === null || v === undefined ? null : String(v);
  };
  switch (expr.fn) {
    case "regex_match": {
      const x = str(0);
      if (x === null) return null;
      const pattern = String(raw(1));
      const caseInsensitiveArg = expr.args[2];
      const caseInsensitive = caseInsensitiveArg !== undefined && evalExpr(caseInsensitiveArg, row) === true;
      return new RegExp(pattern, caseInsensitive ? "i" : "").test(x);
    }
    case "regex_extract": {
      const x = str(0);
      if (x === null) return null;
      const pattern = String(raw(1));
      const groupArg = expr.args[2];
      const group = groupArg !== undefined ? Math.trunc(Number(evalExpr(groupArg, row))) : 0;
      if (Number.isNaN(group) || group < 0) return null;
      const m = new RegExp(pattern).exec(x);
      if (!m) return null;
      const val = m[group];
      return val === undefined ? null : val;
    }
    case "regex_replace": {
      const x = str(0);
      const replacement = str(2);
      if (x === null || replacement === null) return null;
      const pattern = String(raw(1));
      const caseInsensitiveArg = expr.args[3];
      const caseInsensitive = caseInsensitiveArg !== undefined && evalExpr(caseInsensitiveArg, row) === true;
      const re = new RegExp(pattern, caseInsensitive ? "gi" : "g");
      return x.replace(re, translateBackreferences(replacement));
    }
    case "canonicalize": {
      const x = str(0);
      if (x === null) return null;
      return x.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ /, "").replace(/ $/, "");
    }
    case "strip_accents": {
      const x = str(0);
      if (x === null) return null;
      return x.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    case "parse_date": {
      const x = str(0);
      const formatArg = expr.args[1];
      if (x === null || formatArg === undefined || formatArg.kind !== "literal" || typeof formatArg.value !== "string") return null;
      const { re, tokenOrder } = compileDateFormatToRegex(formatArg.value);
      const m = re.exec(x.trim());
      if (!m) return null;
      const parts: Record<DateFormatToken, number> = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
      tokenOrder.forEach((t, idx) => {
        parts[t] = Number(m[idx + 1]);
      });
      if (parts.MM < 1 || parts.MM > 12 || parts.DD < 1 || parts.DD > 31 || parts.HH > 23 || parts.mm > 59 || parts.ss > 59) return null;
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${String(parts.YYYY).padStart(4, "0")}-${pad(parts.MM)}-${pad(parts.DD)}T${pad(parts.HH)}:${pad(parts.mm)}:${pad(parts.ss)}Z`;
    }
    case "parse_number": {
      const v = raw(0);
      if (v === null || v === undefined || typeof v === "boolean") return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v !== "string") return null;
      const decSepArg = expr.args[1];
      const decSep = decSepArg !== undefined ? String(evalExpr(decSepArg, row)) : ".";
      if (decSep !== "." && decSep !== ",") return null;
      const thousandsSep = decSep === "." ? "," : ".";
      let s = v.trim().split(thousandsSep).join("");
      if (decSep !== ".") s = s.replace(decSep, ".");
      if (/[eE]/.test(s)) return null;
      return coerceToNumber(s);
    }
    default:
      // Unreachable — callers only route here via CLEAN_CALL_FNS.has(expr.fn).
      throw new Error(`evalCleanFn: unhandled clean fn "${expr.fn}"`);
  }
}

export function evalExpr(expr: Expr, row: Record<string, unknown>): unknown {
  switch (expr.kind) {
    case "field":
      return row[expr.name] ?? null;
    case "literal":
      return expr.value;
    case "binary": {
      const left = Number(evalExpr(expr.left, row));
      const right = Number(evalExpr(expr.right, row));
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
      }
    }
    case "call": {
      if (expr.fn === "concat") return expr.args.map((a) => evalExpr(a, row)).map((v) => v ?? "").join("");
      if (expr.fn === "coalesce") {
        for (const a of expr.args) {
          const v = evalExpr(a, row);
          if (v !== null && v !== undefined) return v;
        }
        return null;
      }
      if (expr.fn === "is_null") {
        const v = evalExpr(expr.args[0]!, row);
        return v === null || v === undefined;
      }
      if (expr.fn === "is_not_null") {
        const v = evalExpr(expr.args[0]!, row);
        return v !== null && v !== undefined;
      }
      if (expr.fn === "is_missing_token") {
        const v = evalExpr(expr.args[0]!, row);
        if (typeof v !== "string") return false;
        const s = v.trim().toLowerCase();
        return s === "" || MISSING_VALUE_TOKENS.has(s);
      }
      if (expr.fn === "contains") {
        const actual = evalExpr(expr.args[0]!, row);
        const needle = evalExpr(expr.args[1]!, row);
        if (typeof actual !== "string" || typeof needle !== "string") return false;
        // Phase 8b-2b: case-SENSITIVE by default; the optional 3rd (caseInsensitive) arg opts in.
        const caseInsensitiveArg = expr.args[2];
        const caseInsensitive = caseInsensitiveArg !== undefined && evalExpr(caseInsensitiveArg, row) === true;
        return caseInsensitive ? actual.toLowerCase().includes(needle.toLowerCase()) : actual.includes(needle);
      }
      if (MATH_CALL_FNS.has(expr.fn)) return evalMathFn(expr, row);
      if (TEXT_CALL_FNS.has(expr.fn)) return evalTextFn(expr, row);
      if (COERCION_CALL_FNS.has(expr.fn)) return evalCoercionFn(expr, row);
      if (DATE_CALL_FNS.has(expr.fn)) return evalDateFn(expr, row);
      if (CLEAN_CALL_FNS.has(expr.fn)) return evalCleanFn(expr, row);
      if (expr.fn === "is_number") return typeof evalExpr(expr.args[0]!, row) === "number";
      if (expr.fn === "is_text") return typeof evalExpr(expr.args[0]!, row) === "string";
      // looks_numeric
      return looksNumeric(evalExpr(expr.args[0]!, row));
    }
    case "comparison": {
      const left = evalExpr(expr.left, row);
      const right = evalExpr(expr.right, row);
      if (left === null || left === undefined || right === null || right === undefined) return null;
      switch (expr.op) {
        case "eq":
          return left === right;
        case "neq":
          return left !== right;
        case "gt":
          return compareOrdered(left, right) > 0;
        case "gte":
          return compareOrdered(left, right) >= 0;
        case "lt":
          return compareOrdered(left, right) < 0;
        case "lte":
          return compareOrdered(left, right) <= 0;
      }
    }
    case "logical": {
      // Tri-state: null means "unknown", distinct from true/false, per SQL truth tables.
      const triState = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
      if (expr.op === "not") {
        const v = triState(evalExpr(expr.args[0]!, row));
        return v === null ? null : !v;
      }
      const results = expr.args.map((a) => triState(evalExpr(a, row)));
      if (expr.op === "and") {
        if (results.some((v) => v === false)) return false;
        if (results.some((v) => v === null)) return null;
        return true;
      }
      // or
      if (results.some((v) => v === true)) return true;
      if (results.some((v) => v === null)) return null;
      return false;
    }
    case "conditional": {
      for (const b of expr.branches) {
        if (Boolean(evalExpr(b.when, row))) return evalExpr(b.then, row);
      }
      return evalExpr(expr.else, row);
    }
  }
}
