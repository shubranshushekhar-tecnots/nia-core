import { type Expr, typeOfExpr } from "../../expression.js";
import type { AggregationSpec, FilterCondition } from "../../nodeConfig.js";
import type { SqlDialect, SqlDialectAdapter } from "../types.js";
import { PARAM_TOKEN_CHAR, type ParamSink } from "../paramSink.js";

/**
 * The 5 dialect-family-generic SQL primitive bodies, written once and
 * shared by both `mysql` and `postgres` — those two dialects differ only
 * in identifier quoting and placeholder syntax, which is exactly what the
 * two injected functions supply. See ops/types.ts's SqlDialectAdapter doc
 * comments for what each primitive means; bodies here are ported verbatim
 * from the pre-refactor pushdown.ts (conditionToSqlColumn/conditionToSql,
 * aggExprBare, exprToSql, and the whereParts wrapping logic in compileSql/
 * havingClauseToSql), not reimplemented.
 */
export function makeSqlDialectAdapter(
  dialect: SqlDialect,
  quoteIdentImpl: (name: string) => string,
  placeholder: (index: number) => string,
): SqlDialectAdapter {
  /**
   * Condition 1 (docs/decisions.md, Follow-up 1): guards the one place a
   * customer-controlled string (a field/alias name) is embedded as raw
   * SQL text rather than going through ParamSink — a name containing
   * PARAM_TOKEN_CHAR could otherwise forge a fake token that
   * resolveParamSink would mistake for a real one once it lands in
   * whereSql/selectSql/etc. Literal VALUES can't carry this risk (they're
   * always parameterized through ParamSink, never embedded as raw text),
   * so this one guard is sufficient — not per-callsite escaping.
   */
  function quoteIdent(name: string): string {
    if (name.includes(PARAM_TOKEN_CHAR)) {
      throw new Error(`quoteIdent: identifier ${JSON.stringify(name)} contains the reserved ParamSink token character — refusing to quote it.`);
    }
    return quoteIdentImpl(name);
  }
  /**
   * Phase 8b-2b (Fix 4): `contains` is case-SENSITIVE by default
   * (predictable, doesn't vary with a column's collation) — `caseInsensitive`
   * opts into a case-insensitive match. mysql: default forces byte-wise
   * comparison via `LIKE BINARY` (works regardless of the column's own
   * charset/collation, unlike naming a specific collation such as
   * utf8mb4_bin, which errors against a differently-charset'd column);
   * case-insensitive via `LOWER()` on both sides. postgres: plain `LIKE`
   * is already byte-based/case-sensitive by default; case-insensitive via
   * native `ILIKE`.
   */
  function compileContainsSql(target: string, pattern: string, caseInsensitive: boolean | undefined): string {
    if (dialect === "mysql") {
      return caseInsensitive ? `(LOWER(${target}) LIKE LOWER(${pattern}))` : `(${target} LIKE BINARY ${pattern})`;
    }
    return caseInsensitive ? `(${target} ILIKE ${pattern})` : `(${target} LIKE ${pattern})`;
  }

  function compileConditionAgainstTarget(target: string, cond: FilterCondition, params: ParamSink): string {
    if (cond.operator === "is_null") return `${target} IS NULL`;
    if (cond.operator === "is_not_null") return `${target} IS NOT NULL`;
    if (cond.operator === "contains") {
      const token = params.push(`%${cond.value}%`);
      return compileContainsSql(target, token, cond.caseInsensitive);
    }
    const opSql: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    const token = params.push(cond.value);
    // Fix 1 (Phase 8b-2, batch 0): mysql's default column collation is
    // frequently case-insensitive (confirmed live: `name = "ada"` matched a
    // row whose actual value was "Ada"), which silently changes what every
    // eq/neq/ordering comparison means — postgres/mongo/residual all agree
    // and are byte-wise/case-sensitive. Force BINARY (byte-wise) comparison
    // on mysql specifically. Type-guarded to string comparisons only
    // (`typeof cond.value === "string"`, the real JS type FilterCondition
    // preserves) — forcing BINARY on a numeric/boolean comparison is a
    // no-op at best (mysql casts BINARY of a non-string operand back to a
    // string form, e.g. BINARY 5 vs BINARY 10 would wrongly byte-compare
    // "5" > "10") and at worst breaks the comparison, so this must never
    // apply outside the string case. `target` is left un-cast: MySQL's
    // BINARY prefix operator forces the whole comparison to byte-wise even
    // applied to a single operand (documented behavior, same principle
    // `LIKE BINARY` above already relies on) — casting just the literal
    // avoids ever applying BINARY to an aggregate-accumulator SQL fragment
    // (e.g. `MAX(name)`) which could otherwise interact oddly with
    // multi-token expressions.
    const forceBinary = dialect === "mysql" && typeof cond.value === "string";
    const valueSql = forceBinary ? `BINARY ${token}` : token;
    return `${target} ${opSql[cond.operator]} ${valueSql}`;
  }

  function compileCondition(cond: FilterCondition, params: ParamSink): string {
    return compileConditionAgainstTarget(quoteIdent(cond.field), cond, params);
  }

  function compileAggAccumulator(agg: AggregationSpec): string {
    if (agg.fn === "count") return "COUNT(*)";
    // field is non-null for every fn besides "count" — checkConfig (checks.ts) enforces this at check-time; schema-time parse stays permissive per this repo's convention, so field could in principle be null here for a not-yet-checked config. Fall back to COUNT(*) rather than emitting invalid SQL referencing a null column name.
    const col = agg.field ? quoteIdent(agg.field) : "*";
    switch (agg.fn) {
      case "count_field":
        return `COUNT(${col})`;
      case "count_distinct":
        return `COUNT(DISTINCT ${col})`;
      case "sum":
        return `SUM(${col})`;
      case "avg":
        return `AVG(${col})`;
      case "min":
        return `MIN(${col})`;
      case "max":
        return `MAX(${col})`;
      default:
        return "COUNT(*)";
    }
  }

  /**
   * Backs the "looks_numeric" call-fn (Phase 8b-2b) — content-based "does
   * this look like a number" regex match, the pre-8b-2b behavior of
   * is_number/is_text kept under its own name since the coercion
   * specialist needs both this and true-type checking (see
   * compileTrueTypeSql below). The one place mysql/postgres bodies
   * actually diverge in this otherwise dialect-generic factory: MySQL's
   * `REGEXP` and Postgres's `~` take the same POSIX-ish pattern but differ
   * in string-literal backslash-escaping (MySQL string literals interpret
   * `\\`, so a literal backslash needs `\\\\`; Postgres's
   * standard_conforming_strings treats string literals literally, one
   * backslash suffices).
   */
  function compileLooksNumericSql(target: string): string {
    return dialect === "mysql" ? `(${target} REGEXP '^-?[0-9]+(\\\\.[0-9]+)?$')` : `(${target} ~ '^-?[0-9]+(\\.[0-9]+)?$')`;
  }

  /**
   * Backs "is_number"/"is_text" (Phase 8b-2b, Fix 3): the ACTUAL runtime
   * type of the value, matching Mongo's `$isNumber`/`$type` — so a text
   * column containing "123" reports is_text, not is_number (that's
   * looks_numeric's job). Always false for a NULL value (matches Mongo's
   * $isNumber(null) === false), guarded explicitly since neither dialect's
   * type-inspection primitive naturally does that on its own:
   * - mysql: no native TYPEOF. `JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(x), '$[0]'))`
   *   serializes based on the column's declared SQL type (numeric SQL
   *   types -> JSON number, string SQL types -> JSON string) regardless of
   *   the value's content — verified live against a scratch table with a
   *   VARCHAR column containing '123' correctly reporting STRING, not
   *   INTEGER.
   * - postgres: native `pg_typeof(x)` reports the expression's real type
   *   name directly; cast to text via `CAST(... AS text)` rather than the
   *   `::text` shorthand — verified live that guardrails' SQL validator
   *   (packages/guardrails/src/sql/validator.ts) tokenizes `::` into two
   *   adjacent `:` tokens and its reconstruction inserts a space between
   *   them (only `<>`/`!=`/`<=`/`>=` are in its rejoin allowlist), which
   *   turns `pg_typeof(x)::text` into a syntax error at dispatch time —
   *   exactly the "worth naming, not fixed here" gap the Phase 8b-2a
   *   guardrails entry above predicted for Postgres casts. `CAST(...AS
   *   text)` is pure keyword/identifier/paren tokens, so it isn't affected
   *   by that reconstruction gap at all; not fixing the validator itself
   *   here (out of this phase's scope), just not emitting the operator
   *   that triggers it.
   *
   * Fix 2 (Item 3 follow-up audit): `arg` takes a zero-arg CLOSURE, not a
   * precomputed string — this embeds it twice (`IS NOT NULL` + inside
   * `typeExpr`), and the original precomputed-`target`-string version
   * reused that ONE compiled placeholder verbatim at both embed points.
   * Harmless on postgres (numbered `$n` placeholders repeat safely) but a
   * real mysql bug whenever the argument is itself param-bearing (e.g.
   * `is_number(5)` — grammatically valid, min/max arity 1 with no
   * restriction to field-only args): confirmed live, `is_number(5)`
   * compiled to mysql SQL with 2 `?` tokens for this arg but only 1 param
   * pushed, desyncing every placeholder after it. Same root cause/fix
   * shape as `quotient`'s Fix 2 (see its case body) — recompile per
   * occurrence instead of reusing a materialized string.
   */
  function compileTrueTypeSql(arg: () => string, kind: "number" | "text"): string {
    if (dialect === "mysql") {
      const typeExpr = () => `JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(${arg()}), '$[0]'))`;
      const types = kind === "number" ? "'INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL'" : "'STRING'";
      return `(${arg()} IS NOT NULL AND ${typeExpr()} IN (${types}))`;
    }
    const typeExpr = () => `CAST(pg_typeof(${arg()}) AS text)`;
    const types =
      kind === "number"
        ? "'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'"
        : "'text', 'character varying', 'character', '\"char\"', 'name'";
    return `(${arg()} IS NOT NULL AND ${typeExpr()} IN (${types}))`;
  }

  /**
   * Phase 8b-2, Item 3 — the single sanctioned path for every CAST(...)
   * emitted purely to route around Postgres's bind-parameter/overload
   * type-inference ambiguity (an untyped `$n` with no adjacent typed
   * operand to infer from, or an overload Postgres can't resolve for the
   * argument type it received) — never for a genuine semantic conversion
   * (to_text's real text CAST, compileFormatDecimalSql's digit-text
   * CASTs, asText, etc. stay inline; those aren't ambiguity workarounds,
   * they're the actual meaning of the function). Always `CAST(... AS
   * type)`, never `::` — the guardrails tokenizer corrupts `::` into two
   * separate tokens (Phase 8b-2a guardrails entry), and the ::-emission
   * guard depends on nothing here ever producing it.
   *
   * - `castForDialect(sql, mysqlType, postgresType)`: the one primitive
   *   every call below routes through. `mysqlType: null` means "no-op on
   *   mysql" (true bound values there, no untyped-placeholder inference
   *   at all); a non-null `mysqlType` casts on both dialects (only
   *   `compileToBooleanSql`'s static-CASE-branch-typing fix needs this —
   *   Postgres statically type-checks every CASE branch regardless of
   *   runtime reachability, mysql doesn't have that problem but the cast
   *   is harmless there too).
   * - `ambiguousCast(sql, type)`: the common postgres-only case
   *   (`castForDialect(sql, null, type)`) — for a construct whose correct
   *   type is already known from the SQL shape itself (an overload
   *   signature, a fixed comparison target) regardless of whether the
   *   underlying expr is a literal or a column: `log`'s 2-arg numeric
   *   overload, `LPAD`'s integer length arg, `to_text`'s static-boolean
   *   comparison.
   * - `castAmbiguousLiteral(expr, sql, castDateStrings)`: infers the
   *   target type from a BARE LITERAL AST node's JS type/content — for a
   *   position where a literal sits with NO adjacent typed operand at all
   *   (a `CASE` branch, the only proven case so far; the sanctioned path
   *   for any construct batches 5/6 introduce with the same shape — see
   *   the standing rule in docs/decisions.md alongside the null-guard
   *   rule).
   *
   *   Numbers cast to `numeric` (NOT `double precision`, despite this
   *   pass's original entry — see the "Item 3 follow-up" decisions.md
   *   entry: `double precision` was found live to introduce a FALSE-
   *   POSITIVE equality when a CASE branch cast this way is later
   *   compared against a real `bigint` column holding a value beyond
   *   2^53 — two adjacent bigints collide under float64 rounding.
   *   `numeric` is exact/arbitrary-precision decimal, immune to that
   *   collision, while its `/` operator is STILL non-truncating float-like
   *   division (verified live) — same Condition-4 property `double
   *   precision` provided, without 2a's collision risk. One CASE branch
   *   being `numeric`-typed and another being a real `bigint`/`integer`
   *   column composes fine (Postgres widens `integer`/`bigint` to
   *   `numeric` for the comparison, no explicit cast needed on the column
   *   side).
   *
   *   Booleans cast to `boolean`.
   *
   *   Strings: a BARE non-date-shaped string is a proven no-op (Condition
   *   2, Item 3's original entry) — Postgres resolves a bare
   *   `unknown`-typed text literal fine with no adjacent operand at all.
   *   A string shaped like this grammar's canonical ISO-8601 date/
   *   datetime format (same regex `compileToDateSql` accepts — there is
   *   no separate date-literal AST node, so shape is the only signal) is
   *   NOT safe as a no-op: verified live (Item 3 follow-up 3) that an
   *   uncast date-shaped literal in a CASE branch compared against a real
   *   `date`/`timestamptz` column hard-errors ("operator does not exist:
   *   text = date") — Postgres's CASE-branch inference resolves an
   *   untyped param to `text`, not `date`, with no other hint present,
   *   unlike a plain comparison-site literal (see Fix 1/3's decisions.md
   *   entry). So a date-shaped string casts to `timestamptz` — chosen
   *   over `date` because it round-trips BOTH a date-only shape and a
   *   datetime-with-time shape without loss, and compares correctly
   *   against a real `date` OR `timestamp(tz)` column either way (all 4
   *   combinations verified live); casting to `date` instead would
   *   silently drop the time-of-day for a datetime-shaped literal before
   *   a later widen-to-timestamptz comparison, corrupting it.
   *
   *   `castDateStrings` (computed once per `conditional` node by its
   *   caller, from ALL of that CASE's `then`/`else` branches together —
   *   see `planDateStringCast` below) gates the date-string branch: only
   *   true when EVERY string-literal branch in that SAME CASE is
   *   date-shaped. Required, not a simplification: verified live that a
   *   CASE mixing one date-shaped branch (cast to `timestamptz`) with one
   *   plain-string branch (left uncast, per Condition 2) makes Postgres
   *   infer the SECOND branch's type from the first (CASE branches must
   *   share a common type) and try to parse the plain string as a
   *   timestamptz too — hard error ("invalid input syntax for type
   *   timestamp with time zone"), a regression Condition 2's original
   *   uniform no-op never had. Per-branch-independent casting (like
   *   numbers/booleans, which are safe to decide per-branch since EVERY
   *   number/boolean literal casts the same way regardless of its value)
   *   is therefore unsafe for date-shaped strings specifically, since the
   *   cast decision depends on CONTENT, which can legitimately differ
   *   sibling-to-sibling within one CASE.
   *
   *   (`null` case: NOT handled here. A null literal is never parameterized
   *   at all — `compileExpr`'s `case "literal"` emits the raw `NULL`
   *   keyword directly for it, which sidesteps this whole ambiguous-bind-
   *   parameter class of problem instead of needing a CAST workaround; see
   *   that call site's comment for why an unparameterized `NULL` keyword
   *   doesn't have the same inference failure a bound `$n`/`?` does.)
   */
  const ISO_DATE_LITERAL_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}:[0-9]{2})?Z?$/;
  // Hoisted out of compileCoercionFnSql (batch 4) so batch 6's parse_number
  // can reuse the exact same numeric-literal SQL regex text rather than
  // maintaining a second copy that could silently drift from it — same
  // "shared regex constants live at adapter scope" convention as
  // ISO_DATE_LITERAL_RE/ASCII_WS above/below.
  const numRe =
    dialect === "mysql"
      ? "'^[+-]?([0-9]+\\\\.?[0-9]*|\\\\.[0-9]+)([eE][+-]?[0-9]{1,4})?$'"
      : "'^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]{1,4})?$'";
  function castForDialect(sql: string, mysqlType: string | null, postgresType: string): string {
    if (dialect === "mysql") return mysqlType ? `CAST(${sql} AS ${mysqlType})` : sql;
    return `CAST(${sql} AS ${postgresType})`;
  }
  function ambiguousCast(sql: string, type: string): string {
    return castForDialect(sql, null, type);
  }
  /** See castAmbiguousLiteral's `castDateStrings` doc above — computed once per `conditional` node from every then/else branch together, never per-branch. */
  function planDateStringCast(resultExprs: Expr[]): boolean {
    const stringLiterals = resultExprs.filter(
      (e): e is Extract<Expr, { kind: "literal" }> & { value: string } => e.kind === "literal" && typeof e.value === "string",
    );
    return stringLiterals.length > 0 && stringLiterals.every((e) => ISO_DATE_LITERAL_RE.test(e.value));
  }
  function castAmbiguousLiteral(expr: Expr, sql: string, castDateStrings: boolean): string {
    if (expr.kind !== "literal") return sql;
    if (typeof expr.value === "number") return ambiguousCast(sql, "numeric");
    if (typeof expr.value === "boolean") return ambiguousCast(sql, "boolean");
    if (castDateStrings && typeof expr.value === "string") return ambiguousCast(sql, "timestamptz");
    return sql;
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
   * Batch 1 (Phase 8b-2) — DAX-derived Math core (reference/dax-reference.csv).
   * Divide-by-zero, mod-sign, and round-tie-break decisions pinned in
   * docs/decisions.md's batch 1 entry; summarized here:
   *  - divide(n, d, [default=NULL]): d=0 -> default (or NULL if omitted).
   *    Postgres's native `/` throws on division by zero, so every division
   *    below is explicitly zero-guarded, not just for cross-dialect parity.
   *  - mod(n, d): DAX/Excel convention — result takes the SIGN OF THE
   *    DIVISOR, not the dividend (mysql/postgres's native MOD()/`%` use
   *    dividend sign) — built via `n - d*FLOOR(n/d)`, never the native
   *    operator, so every dialect matches DAX. d=0 -> NULL.
   *  - round/round_up/round_down/round_to_multiple: built from
   *    SIGN/FLOOR/CEIL/ABS/POWER rather than native ROUND()/MROUND,
   *    because native ROUND's tie-to-even vs tie-away-from-zero behavior
   *    at exact .5 boundaries differs across mysql/postgres/mongo
   *    (verified live) — homogenized by construction instead of declared.
   *    round_to_multiple's multiple=0 -> 0 (Excel/DAX MROUND(x,0)=0
   *    convention); uses ABS(multiple) — a disclosed simplification
   *    (Excel/DAX errors when number/multiple have opposite sign, this
   *    implementation doesn't).
   *  - quotient(n, d): Excel QUOTIENT truncates toward zero (not floor) —
   *    same TRUNC as the 1-arg `trunc` fn, applied to n/d. d=0 -> NULL.
   *  - int(x) vs trunc(x): `int` floors toward -infinity (DAX INT, same
   *    emission as `floor`); `trunc` truncates toward zero. These differ
   *    for negative non-integers by design (int(-2.5) = -3, trunc(-2.5) =
   *    -2), deliberately not aliased beyond int/floor sharing FLOOR.
   *  - Every math fn here propagates NULL through an operand that's
   *    null/missing. Most of this falls out for free (native ABS(NULL)=NULL
   *    etc., and NULL propagates through the arithmetic/CASE formulas below
   *    automatically) — EXCEPT divide's fallback arg and round_to_multiple's
   *    multiple=0 branch, whose CASE only tests the divisor/multiple, not
   *    the other operand, so each got an explicit "first operand IS NULL"
   *    guard ahead of the zero-check (see their case bodies below) to match
   *    residual's/mongo's unconditional operand-null-first check. Found via
   *    code review while writing this batch's agreement cases, fixed before
   *    the first live run — see docs/decisions.md's batch 1 entry.
   *
   * Batch 2 (Phase 8b-2) — Math remainder: exp|ln|log. Contract (pinned in
   * docs/decisions.md's batch 2 entry, verified live against every
   * engine's actual native behavior before choosing it):
   *  - exp(x): plain EXP(x), no guard — defined for every real x, and
   *    native NULL-propagation is already correct on both dialects.
   *  - ln(x): natural log. x<=0 -> NULL. Mysql's native LN already returns
   *    NULL for x<=0 (verified live), so this guard is a no-op there; but
   *    postgres's native ln() THROWS ("cannot take logarithm of zero" /
   *    "...of a negative number", verified live) rather than nulling the
   *    row out, which would fail the whole query — so it's explicitly
   *    guarded here on both dialects for the same "one bad row shouldn't
   *    kill the query" reason divide/round's zero-guards exist, not left
   *    to diverge as a declared dialect difference.
   *  - log(x, [base]): omitted base = natural log, same contract/emission
   *    as ln(x) (deliberately NOT base-10 — postgres's own single-arg
   *    log(x) IS base-10, which is why the no-base case is emitted via
   *    LN(x) directly here, never via a 1-arg LOG call, to avoid
   *    silently picking up postgres's base-10 default). With an explicit
   *    base: mysql/postgres's native 2-arg LOG(base, x) takes BASE FIRST
   *    (verified live — `LOG(2,4)` = 2, i.e. log base 2 of 4) — the
   *    OPPOSITE order from this grammar's log(x, base), so the emission
   *    below swaps arg(1)/arg(0) into native order. x<=0 OR base<=0 OR
   *    base=1 -> NULL: mysql's native 2-arg LOG already returns NULL for
   *    all three (verified live); postgres's native log(base,x) returns
   *    NULL for x<=0 but THROWS "division by zero" for base=1 specifically
   *    (verified live, log(b,x) is implemented as ln(x)/ln(b) internally)
   *    — so postgres also gets the explicit guard, same "no query-killing
   *    error for one bad row" reasoning as ln.
   *
   * `arg(i)` recompiles expr.args[i] fresh at every call site (never
   * cached into a reused JS string) deliberately: mysql's placeholder is
   * the bare, unnumbered "?" (positional — see mysql.ts), so reusing one
   * compiled literal-operand's placeholder text multiple times in a
   * formula like round's `SIGN(x)*FLOOR(ABS(x)*scale+0.5)/scale` would
   * emit more `?` tokens than params actually pushed, desyncing the bind
   * array. Recompiling per occurrence pushes one param per `?` in
   * left-to-right emission order (template literals evaluate `${...}` in
   * source order), which stays correct for both mysql's positional style
   * and postgres's numbered `$n` style — at the cost of duplicating a
   * literal operand's bind param/SQL text per reuse, an accepted tradeoff
   * for correctness over minimal query size.
   */
  function compileMathFnSql(expr: Extract<Expr, { kind: "call" }>, params: ParamSink): string {
    const arg = (i: number) => compileExpr(expr.args[i]!, params);
    switch (expr.fn) {
      case "abs":
        return `ABS(${arg(0)})`;
      case "ceil":
        return `CEIL(${arg(0)})`;
      case "floor":
      case "int":
        return `FLOOR(${arg(0)})`;
      case "sign":
        return `SIGN(${arg(0)})`;
      case "sqrt":
        return `(CASE WHEN ${arg(0)} < 0 THEN NULL ELSE SQRT(${arg(0)}) END)`;
      case "trunc":
        return dialect === "mysql" ? `TRUNCATE(${arg(0)}, 0)` : `TRUNC(CAST(${arg(0)} AS numeric), 0)`;
      case "power":
        return `POWER(${arg(0)}, ${arg(1)})`;
      case "divide": {
        const fallback = expr.args[2] ? arg(2) : "NULL";
        // n IS NULL is checked before the d=0 branch specifically: without
        // it, divide(NULL, 0, 0) would return the fallback 0 (the CASE only
        // tests d), diverging from every other evaluator's "null operand
        // always wins" contract (residual/mongo check n===null first,
        // unconditionally). d IS NULL doesn't need the same explicit guard:
        // `d = 0` is NULL (not true) when d is NULL, falling through to
        // n/d = n/NULL = NULL via ordinary SQL null-propagation, already
        // consistent.
        return `(CASE WHEN ${arg(0)} IS NULL THEN NULL WHEN ${arg(1)} = 0 THEN ${fallback} ELSE (${arg(0)} / ${arg(1)}) END)`;
      }
      case "mod":
        return `(CASE WHEN ${arg(1)} = 0 THEN NULL ELSE (${arg(0)} - ${arg(1)} * FLOOR(${arg(0)} / ${arg(1)})) END)`;
      case "quotient": {
        // Item 3 follow-up 2b / Fix 2 — was a plain `const truncSql = ...`,
        // eagerly evaluated (pushing arg(0)/arg(1)'s params) BEFORE the
        // outer template's own `${arg(1)}` zero-check call, whose `?`
        // placeholder sits textually FIRST in the final mysql string but
        // was pushed chronologically LAST — desyncing mysql's positional
        // bind array whenever arg(0) itself pushes any params (e.g. a
        // CASE-branch dividend). A zero-arg closure, invoked at its own
        // textual embed point, keeps evaluation order == textual order —
        // same discipline `arg(i)` itself and every other multi-occurrence
        // helper in this file already follows (see `arg(i)`'s doc comment
        // above). Postgres's numbered `$n` placeholders were never at risk
        // (see docs/decisions.md's Fix 2 entry) — this is a mysql-only bug.
        const truncSql = () =>
          dialect === "mysql" ? `TRUNCATE((${arg(0)}) / (${arg(1)}), 0)` : `TRUNC(CAST((${arg(0)}) / (${arg(1)}) AS numeric), 0)`;
        return `(CASE WHEN ${arg(1)} = 0 THEN NULL ELSE ${truncSql()} END)`;
      }
      case "round":
      case "round_up":
      case "round_down": {
        const digits = () => (expr.args[1] ? arg(1) : "0");
        if (expr.fn === "round_down") return `(SIGN(${arg(0)}) * FLOOR(ABS(${arg(0)}) * POWER(10, ${digits()})) / POWER(10, ${digits()}))`;
        if (expr.fn === "round_up") return `(SIGN(${arg(0)}) * CEIL(ABS(${arg(0)}) * POWER(10, ${digits()})) / POWER(10, ${digits()}))`;
        return `(SIGN(${arg(0)}) * FLOOR(ABS(${arg(0)}) * POWER(10, ${digits()}) + 0.5) / POWER(10, ${digits()}))`;
      }
      case "round_to_multiple":
        // Same x-IS-NULL-first guard as divide above: the m=0 branch
        // returns a non-null literal (0), so it must not fire ahead of a
        // null check on x.
        return `(CASE WHEN ${arg(0)} IS NULL THEN NULL WHEN ${arg(1)} = 0 THEN 0 ELSE SIGN(${arg(0)}) * FLOOR(ABS(${arg(0)}) / ABS(${arg(1)}) + 0.5) * ABS(${arg(1)}) END)`;
      case "exp":
        return `EXP(${arg(0)})`;
      case "ln":
        return `(CASE WHEN ${arg(0)} <= 0 THEN NULL ELSE LN(${arg(0)}) END)`;
      case "log": {
        if (!expr.args[1]) return `(CASE WHEN ${arg(0)} <= 0 THEN NULL ELSE LN(${arg(0)}) END)`;
        // Native LOG(base, x) takes base first — opposite of this
        // grammar's log(x, base) — so arg(1)/arg(0) are swapped here.
        // Postgres-only wrinkle, found live while verifying batch 2 (not
        // predicted from docs, only surfaced by actually running the
        // query): postgres has NO `log(double precision, double
        // precision)` overload — only `log(numeric, numeric)` — so the
        // bare bind-param form ("function log(double precision, double
        // precision) does not exist") fails at execution time even
        // though it parses/plans fine (same class of "looks right,
        // executes wrong" gap the 8b-2a conformance harness exists to
        // catch). Mysql's LOG(base, x) has no such overload restriction
        // (verified live), so only postgres needs the explicit
        // `CAST(...AS numeric)` on both operands.
        const call = (i: number) => ambiguousCast(arg(i), "numeric");
        return `(CASE WHEN ${arg(0)} <= 0 OR ${arg(1)} <= 0 OR ${arg(1)} = 1 THEN NULL ELSE LOG(${call(1)}, ${call(0)}) END)`;
      }
      default:
        // Unreachable — callers only route here via MATH_CALL_FNS.has(expr.fn).
        throw new Error(`compileMathFnSql: unhandled math fn "${expr.fn}"`);
    }
  }

  const TEXT_CALL_FNS = new Set(["upper", "lower", "trim", "left", "right", "mid", "len", "substitute", "find", "rept", "split"]);

  /**
   * Batch 3 (Phase 8b-2) — DAX-derived Text core (+ split). Every contract
   * below is pinned in docs/decisions.md's batch 3 entry with the live
   * verification that grounded it; summarized here:
   *  - upper/lower: default (locale-INVARIANT, not locale-AWARE) case
   *    mapping — every engine's plain UPPER()/LOWER()/$toUpper/$toLower/
   *    toUpperCase() already behaves this way with no special-casing
   *    (Turkish dotless-i is NOT handled correctly by any of them; that's
   *    the disclosed limit of this contract, not a bug).
   *  - len: character (Unicode CODE POINT) count, not byte count. mysql/
   *    postgres CHAR_LENGTH is already code-point-based (verified live:
   *    both report 12 for "café ñ 日本語 🎉", correctly counting the
   *    4-byte utf8mb4/UTF8 emoji as ONE character) — only residualEval.ts's
   *    native `.length` (UTF-16 code UNITS) needs a fix, since it double-
   *    counts any astral character.
   *  - find(needle, haystack, [caseInsensitive]): case-SENSITIVE by
   *    default (standing rule, same as contains) via mysql BINARY forcing;
   *    1-based, code-point-based position (verified live: mysql
   *    LOCATE/postgres STRPOS/mongo $indexOfCP all agree, finding "ada" in
   *    "the ada lovelace" at 1-based position 5); 0 when not found; empty
   *    needle -> 1 (verified live: mysql LOCATE('','x') AND postgres
   *    strpos('x','') both already return 1 natively — no divergence, no
   *    guard needed, unlike the emptiness contracts below that DO need
   *    one).
   *  - left/right/mid: negative n -> clamp to 0 (empty result). This is a
   *    REQUIRED explicit guard, not a stylistic choice: verified live that
   *    postgres's native LEFT/RIGHT treat negative n as "all but last |n|
   *    characters" (`left('hello',-1)` = 'hell'), while mysql's native
   *    LEFT/RIGHT return '' for negative n — a genuine cross-dialect
   *    divergence, homogenized here by GREATEST(n,0) clamping on both
   *    before it ever reaches the native function. mid's start is 1-based;
   *    start<1 clamps to 1 — also REQUIRED, not stylistic: verified live
   *    that mysql's negative SUBSTRING start means "count from the end"
   *    (`SUBSTRING('hello',-2,3)` = 'lo') while postgres's negative/zero
   *    start is a sliding window silently clipped against the string's
   *    real bounds (`substring('hello' from 0 for 3)` = 'he',
   *    `from -2 for 3` = '') — two INCOMPATIBLE native behaviors, neither
   *    used; GREATEST(start,1) overrides both. n larger than the string is
   *    already consistent natively on both dialects (verified live, no
   *    guard needed) — LEFT/RIGHT/SUBSTRING all clamp to the available
   *    string.
   *  - substitute(text, search, replacement): global, non-overlapping,
   *    left-to-right, single pass over the ORIGINAL string (verified live
   *    this is already every engine's native REPLACE/replaceAll/
   *    $replaceAll behavior — substitute("aaa","a","aa") = "aaaaaa", never
   *    re-scans inserted replacement text). Empty search string -> return
   *    text UNCHANGED: mysql/postgres's native REPLACE(x,'',y) already
   *    no-ops (verified live), so the CASE guard is a no-op there, but
   *    it's still REQUIRED for cross-adapter contract parity since
   *    mongo.ts's/residualEval.ts's native primitives do NOT no-op on an
   *    empty search (see their doc comments).
   *  - trim: strips ASCII whitespace ONLY (space/tab/LF/VT/FF/CR), not the
   *    broader Unicode whitespace set. This is a REQUIRED explicit choice,
   *    not a default: mysql/postgres's native TRIM(x) (no explicit char)
   *    strips ONLY the ASCII space character, not tabs/newlines — too
   *    narrow for this contract — so built via REGEXP_REPLACE/regexp_replace
   *    instead of native TRIM, stripping the full ASCII-whitespace
   *    character class from both ends. Raw control bytes (actual tab/LF/
   *    CR/FF/VT characters via JS's `\t`/`\n`/`\r`/`\f`/`\v` escapes) are
   *    embedded directly in the regex character class rather than
   *    backslash-escape sequences (`\\t` etc.) — sidesteps mysql string
   *    literals' backslash-unescaping (already a documented wrinkle in
   *    compileLooksNumericSql above) entirely, since a literal control
   *    byte inside `[...]` needs no escaping on either dialect.
   *  - rept(text, n): n=0 -> ''. Negative n -> clamp to 0 -> '' (disclosed
   *    simplification — Excel/DAX REPT errors on negative n, but this
   *    grammar has no error-propagation path). Repeat count capped at
   *    1000 via LEAST(GREATEST(n,0),1000) — a disclosed defensive ceiling
   *    (not modeled on any specific DAX/Excel limit), applied uniformly
   *    BEFORE the repeat so mongo.ts's $reduce-based construction (Mongo
   *    has no native repeat-string operator at all) stays bounded too.
   *  - split(text, delimiter, index): index is REQUIRED (grammar has no
   *    array/list value type — split always resolves one scalar part,
   *    never the whole split array). 1-based. Empty delimiter -> NULL for
   *    every index — REQUIRED explicit guard: verified live that mongo's
   *    $split THROWS on an empty separator ("$split requires a non-empty
   *    separator"), so every adapter guards it uniformly rather than
   *    leaving mysql/postgres to silently no-op while mongo errors.
   *    Index out of range (<1 or > part count) -> NULL, explicit
   *    bounds-checked on every adapter (mysql's SUBSTRING_INDEX idiom has
   *    no native bounds error to lean on; postgres array indexing returns
   *    NULL out-of-range natively, but the explicit check is kept for a
   *    uniform, non-native-dependent guarantee). Multi-byte delimiter is
   *    literal-substring matching everywhere already (verified live, no
   *    special-casing needed) since none of SUBSTRING_INDEX/string_to_array/
   *    $split/String.prototype.split treat the delimiter as a regex.
   *
   * mysql has no native SPLIT_PART-equivalent; built from the
   * SUBSTRING_INDEX(SUBSTRING_INDEX(x,d,n),d,-1) idiom, with an explicit
   * part-count guard (`(CHAR_LENGTH(x)-CHAR_LENGTH(REPLACE(x,d,'')))/
   * CHAR_LENGTH(d)+1` = delimiter-occurrence-count + 1) ahead of it —
   * division by CHAR_LENGTH(d) is safe here since the `d = ''` branch is
   * checked first and always short-circuits. postgres instead uses native
   * `string_to_array(x,d)` + 1-based array indexing (`arr[n]`) +
   * `array_length(arr,1)`, both real postgres primitives — cleaner than
   * SPLIT_PART for bounds-checking since array_length gives the part count
   * directly.
   */
  const ASCII_WS = " \t\n\r\f\v";
  function compileTextFnSql(expr: Extract<Expr, { kind: "call" }>, params: ParamSink): string {
    const arg = (i: number) => compileExpr(expr.args[i]!, params);
    switch (expr.fn) {
      case "upper":
        return `UPPER(${arg(0)})`;
      case "lower":
        return `LOWER(${arg(0)})`;
      case "trim": {
        const wsPattern = `^[${ASCII_WS}]+|[${ASCII_WS}]+$`;
        return dialect === "mysql"
          ? `REGEXP_REPLACE(${arg(0)}, '${wsPattern}', '')`
          : `regexp_replace(${arg(0)}, '${wsPattern}', '', 'g')`;
      }
      case "left":
        return `LEFT(${arg(0)}, GREATEST(${arg(1)}, 0))`;
      case "right":
        return `RIGHT(${arg(0)}, GREATEST(${arg(1)}, 0))`;
      case "mid":
        return dialect === "mysql"
          ? `SUBSTRING(${arg(0)}, GREATEST(${arg(1)}, 1), GREATEST(${arg(2)}, 0))`
          : `SUBSTRING(${arg(0)} FROM GREATEST(${arg(1)}, 1) FOR GREATEST(${arg(2)}, 0))`;
      case "len":
        return `CHAR_LENGTH(${arg(0)})`;
      case "substitute":
        return `(CASE WHEN ${arg(1)} = '' THEN ${arg(0)} ELSE REPLACE(${arg(0)}, ${arg(1)}, ${arg(2)}) END)`;
      case "find": {
        const caseInsensitiveArg = expr.args[2];
        const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
        if (dialect === "mysql") {
          // Fix 4's BINARY case-sensitivity pattern, applied to LOCATE the
          // same way compileContainsSql applies it to LIKE.
          return caseInsensitive ? `LOCATE(LOWER(${arg(0)}), LOWER(${arg(1)}))` : `LOCATE(BINARY ${arg(0)}, BINARY ${arg(1)})`;
        }
        // postgres STRPOS's arg order is (haystack, needle) — opposite of
        // this grammar's find(needle, haystack) and of mysql's own
        // LOCATE(needle, haystack) — already byte-wise/case-sensitive by
        // default like LIKE, so no BINARY-equivalent forcing needed here.
        return caseInsensitive ? `STRPOS(LOWER(${arg(1)}), LOWER(${arg(0)}))` : `STRPOS(${arg(1)}, ${arg(0)})`;
      }
      case "rept":
        return `REPEAT(${arg(0)}, LEAST(GREATEST(${arg(1)}, 0), 1000))`;
      case "split": {
        if (dialect === "mysql") {
          return (
            `(CASE WHEN ${arg(1)} = '' THEN NULL WHEN ${arg(2)} < 1 THEN NULL ` +
            `WHEN ${arg(2)} > (CHAR_LENGTH(${arg(0)}) - CHAR_LENGTH(REPLACE(${arg(0)}, ${arg(1)}, ''))) / CHAR_LENGTH(${arg(1)}) + 1 THEN NULL ` +
            `ELSE SUBSTRING_INDEX(SUBSTRING_INDEX(${arg(0)}, ${arg(1)}, ${arg(2)}), ${arg(1)}, -1) END)`
          );
        }
        return (
          `(CASE WHEN ${arg(1)} = '' THEN NULL WHEN ${arg(2)} < 1 THEN NULL ` +
          `WHEN ${arg(2)} > array_length(string_to_array(${arg(0)}, ${arg(1)}), 1) THEN NULL ` +
          `ELSE (string_to_array(${arg(0)}, ${arg(1)}))[${arg(2)}] END)`
        );
      }
      default:
        // Unreachable — callers only route here via TEXT_CALL_FNS.has(expr.fn).
        throw new Error(`compileTextFnSql: unhandled text fn "${expr.fn}"`);
    }
  }

  /** Runtime true-type number check, same closure-recompile-per-embed discipline as compileTrueTypeSql above (both take a zero-arg closure now, post-Fix-2 — see compileTrueTypeSql's doc comment) since this one needs it safe with a literal/computed arg too, not just a field reference. */
  function compileIsNumberSql(i: number, arg: (idx: number) => string): string {
    if (dialect === "mysql") {
      const typeExpr = () => `JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(${arg(i)}), '$[0]'))`;
      return `(${arg(i)} IS NOT NULL AND ${typeExpr()} IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL'))`;
    }
    const typeExpr = () => `CAST(pg_typeof(${arg(i)}) AS text)`;
    return `(${arg(i)} IS NOT NULL AND ${typeExpr()} IN ('smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'))`;
  }

  /**
   * Round-half-away-from-zero digit construction shared by to_text's
   * number branch and format_number — mirrors residualEval.ts's
   * formatDecimal(x, decimals) exactly (same scale/floor/split formula),
   * built from POWER/FLOOR/ABS/LPAD/CONCAT rather than native
   * FORMAT/to_char, since those diverge on locale (thousands separators)
   * and rounding mode across engines (verified live, same reasoning as
   * batch 1's round()). `valueSql`/`decSql` are zero-arg closures (not
   * plain strings) for the same per-occurrence-recompile reason as
   * coerceNumberSql above — each is invoked fresh at every embed point.
   * `stripTrailingZeros`: true for to_text (variable-precision display,
   * decSql fixed at "6"), false for format_number (exact, zero-padded to
   * the caller's requested decimal count, never stripped).
   */
  function compileFormatDecimalSql(valueSql: () => string, decSql: () => string, stripTrailingZeros: boolean): string {
    const scale = () => `POWER(10, ${decSql()})`;
    const scaled = () => `FLOOR(ABS(${valueSql()}) * ${scale()} + 0.5)`;
    const intPart = () => `FLOOR(${scaled()} / ${scale()})`;
    const fracPart = () => `(${scaled()} - ${intPart()} * ${scale()})`;
    const intText = () => (dialect === "mysql" ? `CAST(${intPart()} AS CHAR)` : `CAST(${intPart()} AS text)`);
    const fracRawText = () => (dialect === "mysql" ? `CAST(${fracPart()} AS CHAR)` : `CAST(${fracPart()} AS text)`);
    // LPAD's length arg must be INTEGER on postgres — decSql() is a NUMERIC-
    // typed expression (clampedDecimalsSql's TRUNC(CAST(... AS numeric),0)),
    // and postgres has no lpad(text, numeric, text) overload ("function lpad
    // (text, numeric, unknown) does not exist", found live). mysql's LPAD
    // accepts any numeric-ish arg via implicit coercion, so this cast is a
    // postgres-only requirement.
    const lpadLen = () => ambiguousCast(decSql(), "integer");
    const fracPadded = () => `LPAD(${fracRawText()}, ${lpadLen()}, '0')`;
    const frac = () => (stripTrailingZeros ? `TRIM(TRAILING '0' FROM ${fracPadded()})` : fracPadded());
    const sign = () => `(CASE WHEN ${valueSql()} < 0 AND ${scaled()} <> 0 THEN '-' ELSE '' END)`;
    const withFrac = () => `CONCAT(${sign()}, ${intText()}, '.', ${frac()})`;
    const withoutFrac = () => `CONCAT(${sign()}, ${intText()})`;
    const body = stripTrailingZeros
      ? `(CASE WHEN ${frac()} = '' THEN ${withoutFrac()} ELSE ${withFrac()} END)`
      : `(CASE WHEN ${decSql()} = 0 THEN ${withoutFrac()} ELSE ${withFrac()} END)`;
    return `(CASE WHEN ${valueSql()} IS NULL OR ${decSql()} IS NULL THEN NULL ELSE ${body} END)`;
  }

  /** to_text's scalar (non-statically-boolean) branch: runtime is-number check picks number-formatting (compileFormatDecimalSql, 6 decimals, stripped) vs plain text CAST. */
  function compileNumberOrTextToTextSql(i: number, arg: (idx: number) => string, asText: (idx: number) => string): string {
    const isNum = compileIsNumberSql(i, arg);
    const asDouble = () => (dialect === "mysql" ? `CAST(${arg(i)} AS DOUBLE)` : `CAST(${arg(i)} AS double precision)`);
    const numText = () => compileFormatDecimalSql(asDouble, () => "6", true);
    return `(CASE WHEN ${arg(i)} IS NULL THEN NULL WHEN ${isNum} THEN ${numText()} ELSE ${asText(i)} END)`;
  }

  /** NULL -> NULL; static-boolean passthrough; runtime number: 1->true/0->false/else NULL; runtime string: trim+lowercase, 'true'|'1'->true, 'false'|'0'->false, else NULL. */
  function compileToBooleanSql(expr: Extract<Expr, { kind: "call" }>, arg: (idx: number) => string, asText: (idx: number) => string): string {
    if (typeOfExpr(expr.args[0]!) === "boolean") return arg(0);
    const isNum = compileIsNumberSql(0, arg);
    // Postgres statically type-checks EVERY CASE branch regardless of
    // runtime reachability — a bare `${arg(0)} = 1` fails to even prepare
    // ("operator does not exist: text = integer") when the underlying
    // column is text, even though this branch only runs when isNum is
    // true. Found live. Cast to double precision first (well-typed for
    // any column type, only actually evaluated at runtime when isNum
    // gates it true).
    const asDouble0 = () => castForDialect(arg(0), "DOUBLE", "double precision");
    const numBranch = `(CASE WHEN ${asDouble0()} = 1 THEN TRUE WHEN ${asDouble0()} = 0 THEN FALSE ELSE NULL END)`;
    const strBranch = () => {
      const s = () => `TRIM(LOWER(${asText(0)}))`;
      return `(CASE WHEN ${s()} IN ('true', '1') THEN TRUE WHEN ${s()} IN ('false', '0') THEN FALSE ELSE NULL END)`;
    };
    return `(CASE WHEN ${arg(0)} IS NULL THEN NULL WHEN ${isNum} THEN ${numBranch} ELSE ${strBranch()} END)`;
  }

  /**
   * ISO-8601-only fast path, built purely from REGEXP/SUBSTRING/CONCAT —
   * deliberately no native date-parsing primitive (mysql STR_TO_DATE/
   * postgres to_timestamp diverge on format-string dialects and invalid-
   * date handling; avoided entirely, same "homogenize by construction"
   * approach as batch 1's round()). Only 2 fixed-width shapes accepted:
   * `YYYY-MM-DD` (date-only, time defaults 00:00:00) and
   * `YYYY-MM-DD[T ]HH:MM:SS` (seconds REQUIRED when time is present) —
   * both with an optional trailing `Z`. Fractional seconds and explicit
   * numeric UTC offsets (e.g. +05:00) are NOT matched -> NULL, a
   * disclosed simplification (see docs/decisions.md's batch 4 entry).
   * Fixed component widths let every field be extracted via a plain
   * 1-based SUBSTRING at a constant position — no capture-group
   * extraction function needed (mysql/postgres don't share one), and no
   * loop/conditional-width parsing required.
   */
  function compileToDateSql(expr: Extract<Expr, { kind: "call" }>, arg: (idx: number) => string): string {
    const s = () => `TRIM(${dialect === "mysql" ? `CAST(${arg(0)} AS CHAR)` : `CAST(${arg(0)} AS text)`})`;
    const pattern = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}:[0-9]{2})?Z?$'";
    const matches = () => (dialect === "mysql" ? `${s()} REGEXP ${pattern}` : `${s()} ~ ${pattern}`);
    const sub = (start: number, len: number) =>
      dialect === "mysql" ? `SUBSTRING(${s()}, ${start}, ${len})` : `SUBSTRING(${s()} FROM ${start} FOR ${len})`;
    const hasTime = () => `CHAR_LENGTH(${s()}) >= 19`;
    const intCast = (sql: string) => (dialect === "mysql" ? `CAST(${sql} AS SIGNED)` : `CAST(${sql} AS integer)`);
    const y = () => sub(1, 4);
    const mo = () => sub(6, 2);
    const d = () => sub(9, 2);
    const h = () => `(CASE WHEN ${hasTime()} THEN ${sub(12, 2)} ELSE '00' END)`;
    const mi = () => `(CASE WHEN ${hasTime()} THEN ${sub(15, 2)} ELSE '00' END)`;
    const se = () => `(CASE WHEN ${hasTime()} THEN ${sub(18, 2)} ELSE '00' END)`;
    const boundsOk =
      `${intCast(mo())} BETWEEN 1 AND 12 AND ${intCast(d())} BETWEEN 1 AND 31 AND ` +
      `${intCast(h())} BETWEEN 0 AND 23 AND ${intCast(mi())} BETWEEN 0 AND 59 AND ${intCast(se())} BETWEEN 0 AND 59`;
    return (
      `(CASE WHEN ${arg(0)} IS NULL THEN NULL WHEN NOT (${matches()}) THEN NULL WHEN NOT (${boundsOk}) THEN NULL ` +
      `ELSE CONCAT(${y()}, '-', ${mo()}, '-', ${d()}, 'T', ${h()}, ':', ${mi()}, ':', ${se()}, 'Z') END)`
    );
  }

  const COERCION_CALL_FNS = new Set(["to_number", "to_integer", "to_text", "format_number", "to_boolean", "to_date"]);

  /**
   * Batch 4 (Phase 8b-2) — Coercion vocabulary. Full contract pinned in
   * docs/decisions.md's batch 4 entry; this comment covers only the SQL
   * construction strategy. Every helper below is a zero-arg CLOSURE, not a
   * precomputed string — same "recompile per occurrence" discipline as
   * compileMathFnSql's `arg(i)` (see its doc comment): a closure that
   * internally calls `arg(i)`/`asText(i)` pushes a fresh param every time
   * it's INVOKED, so reusing the closure itself (calling it again) at each
   * embed point keeps every SQL-text placeholder paired 1:1 with a param
   * push. Reusing a materialized STRING result (calling it once, then
   * splicing that string into the template multiple times) would desync
   * mysql's positional `?` count from the params array — never done here,
   * even though it means the final SQL is far more verbose than a
   * hand-written query would be.
   *
   * `typeOfExpr` (exported from expression.ts specifically for this batch)
   * statically detects an AST-level boolean-typed argument (a literal
   * boolean, a comparison, a logical op, or another BOOLEAN_CALL_FNS
   * result) and short-circuits to constant-NULL (to_number/to_integer) or
   * a direct 'true'/'false' CASE (to_text) — avoiding postgres's
   * boolean-has-no-implicit-numeric-coercion error entirely, never
   * attempting arithmetic on a boolean SQL expression. This does NOT
   * detect a boolean-TYPED COLUMN (a `field` reference is always "scalar"
   * to typeOfExpr — the grammar has no column-type awareness anywhere) —
   * a disclosed, narrow gap: postgres `CAST(bool_col AS text)` naturally
   * yields 'true'/'false' (still correctly fails the numeric regex below
   * -> NULL, matching the boolean contract by coincidence), but mysql has
   * no real boolean column type (TINYINT(1) CASTs to '1'/'0' text, which
   * WOULD match the numeric regex and parse as 1/0) — diverges from
   * postgres/residual's "boolean -> null" contract only in this narrow
   * mysql-TINYINT-column-fed-directly-into-a-coercion-fn case.
   */
  function compileCoercionFnSql(expr: Extract<Expr, { kind: "call" }>, params: ParamSink): string {
    const arg = (i: number) => compileExpr(expr.args[i]!, params);
    const asText = (i: number) => (dialect === "mysql" ? `CAST(${arg(i)} AS CHAR)` : `CAST(${arg(i)} AS text)`);

    /**
     * Shared by to_number/to_integer/format_number's both args: NULL ->
     * NULL; boolean-typed (static) -> NULL; else TRIM+CAST-to-text, must
     * match `numRe` (else NULL), overflow-guarded via exponent magnitude
     * (>308 -> NULL) and plain-digit text length (>320 chars, guaranteed
     * to overflow a double's ~1.8e308 range -> NULL) before the final
     * CAST to DOUBLE/double precision — sidesteps every native
     * overflow-error/silent-clamp divergence found live (mysql clamps,
     * postgres errors, mongo's $toDouble errors) by never letting an
     * out-of-range value reach the native numeric CAST at all.
     */
    const coerceNumberSql = (i: number): string => {
      if (typeOfExpr(expr.args[i]!) === "boolean") return "NULL";
      const t = () => `TRIM(${asText(i)})`;
      const matches = () => (dialect === "mysql" ? `${t()} REGEXP ${numRe}` : `${t()} ~ ${numRe}`);
      const ePos = () => (dialect === "mysql" ? `LOCATE('e', LOWER(${t()}))` : `POSITION('e' IN LOWER(${t()}))`);
      const expText = () => (dialect === "mysql" ? `SUBSTRING(${t()}, ${ePos()} + 1)` : `SUBSTRING(${t()} FROM ${ePos()} + 1)`);
      const expInt = () => (dialect === "mysql" ? `CAST(${expText()} AS SIGNED)` : `CAST(${expText()} AS integer)`);
      const asDouble = () => (dialect === "mysql" ? `CAST(${t()} AS DOUBLE)` : `CAST(${t()} AS double precision)`);
      // Explicit CAST here, not a bare `${arg(i)} IS NULL` — found live:
      // when arg(i) is a LITERAL (e.g. format_number's decimals arg), a
      // bare untyped param used ONLY in an IS NULL test (no other
      // occurrence of that same placeholder to hint its type) fails
      // postgres's parameter type inference ("could not determine data
      // type of parameter $1"). `t()` is already explicitly cast to text.
      return (
        `(CASE WHEN ${t()} IS NULL THEN NULL ` +
        `WHEN NOT (${matches()}) THEN NULL ` +
        `WHEN ${ePos()} > 0 AND ABS(${expInt()}) > 308 THEN NULL ` +
        `WHEN ${ePos()} = 0 AND CHAR_LENGTH(${t()}) > 320 THEN NULL ` +
        `ELSE ${asDouble()} END)`
      );
    };

    /** decimals arg, coerced/truncated/clamped to [0,10]. Explicit NULL guard BEFORE GREATEST/LEAST — required, not stylistic: verified live that postgres's GREATEST/LEAST IGNORE null arguments (GREATEST(NULL,0)=0), while mysql's propagate null (GREATEST(NULL,0)=NULL) — a genuine cross-dialect divergence homogenized here by construction. */
    const clampedDecimalsSql = (i: number): string => {
      const truncated = () =>
        dialect === "mysql" ? `TRUNCATE(${coerceNumberSql(i)}, 0)` : `TRUNC(CAST(${coerceNumberSql(i)} AS numeric), 0)`;
      return `(CASE WHEN ${coerceNumberSql(i)} IS NULL THEN NULL ELSE LEAST(GREATEST(${truncated()}, 0), 10) END)`;
    };

    switch (expr.fn) {
      case "to_number":
        return coerceNumberSql(0);
      case "to_integer":
        // TRUNCATE(NULL,0)/TRUNC(CAST(NULL AS numeric),0) both -> NULL natively on both dialects, so wrapping the whole (already NULL-safe) coerceNumberSql result needs no extra guard.
        return dialect === "mysql" ? `TRUNCATE(${coerceNumberSql(0)}, 0)` : `TRUNC(CAST(${coerceNumberSql(0)} AS numeric), 0)`;
      case "to_text": {
        if (typeOfExpr(expr.args[0]!) === "boolean") {
          // Postgres's extended-query-protocol parameter type inference
          // fails ("could not determine data type of parameter $1") when a
          // bare literal param is used in both an IS NULL check and a WHEN
          // truth-test within the same CASE — found live. Explicit CAST on
          // each occurrence removes the ambiguity; mysql has no such
          // limitation (real bound values, not untyped placeholders) and
          // has no "AS boolean" cast target, so left unguarded there.
          const b = () => ambiguousCast(arg(0), "boolean");
          return `(CASE WHEN ${b()} IS NULL THEN NULL WHEN ${b()} THEN 'true' ELSE 'false' END)`;
        }
        return compileNumberOrTextToTextSql(0, arg, asText);
      }
      case "format_number": {
        const valueSql = () => coerceNumberSql(0);
        const decSql = () => clampedDecimalsSql(1);
        return compileFormatDecimalSql(valueSql, decSql, false);
      }
      case "to_boolean":
        return compileToBooleanSql(expr, arg, asText);
      case "to_date":
        return compileToDateSql(expr, arg);
      default:
        // Unreachable — callers only route here via COERCION_CALL_FNS.has(expr.fn).
        throw new Error(`compileCoercionFnSql: unhandled coercion fn "${expr.fn}"`);
    }
  }

  const DATE_CALL_FNS = new Set([
    "year", "month", "day", "hour", "minute", "second", "quarter", "weekday", "date_diff", "date_add",
  ]);

  /**
   * Phase 8b-2, batch 5 — Date-part vocabulary. Full contract + probe
   * findings pinned in docs/decisions.md's batch 5 entry; this comment
   * covers only the SQL construction strategy.
   *
   * Type-driven coercion (compileDateCoerceSql below), NOT the
   * conditional-branch content-shape heuristic (castAmbiguousLiteral/
   * planDateStringCast above) — every one of these 10 functions
   * unconditionally requires its date-typed arg(s) to resolve to a real
   * temporal value or NULL, regardless of what kind of expression
   * produced it (column, literal, nested call). Confirmed live
   * (apps/worker/scripts/date-part-fn-probe.ts):
   *   - mysql: YEAR()/MONTH()/.../QUARTER()/WEEKDAY() and EXTRACT(...
   *     FROM ...) all work directly on a real DATE/DATETIME column OR on
   *     a validated ISO-8601 text value, and resolve to NULL (never
   *     throw) on non-ISO-shaped text — so mysql needs only ONE
   *     regex-guarded text path, no separate real-column branch.
   *   - postgres: a bare `date`-typed column throws on HOUR/MINUTE/
   *     SECOND extraction ("unit \"hour\" not supported for type date"),
   *     and a bound untyped param used only in EXTRACT fails type
   *     inference entirely ("function pg_catalog.extract(unknown,
   *     unknown) is not unique") — so postgres needs pg_typeof to detect
   *     a genuine date/timestamp/timestamptz column (cast directly,
   *     always safe) vs. a text/literal value (regex-guarded, THEN cast
   *     — a blind CAST(garbage AS timestamptz) hard-errors rather than
   *     returning NULL, confirmed live).
   * ISO weekday (Mon=1..Sun=7): postgres's EXTRACT(ISODOW FROM ...) and
   * mysql's WEEKDAY()+1 both confirmed live to give this numbering
   * directly — no manual remapping needed on the SQL side.
   * UTC-everywhere: postgres session timezone is pinned to UTC at the
   * connector-pool level (services/connector-supabase/src/pool-
   * manager.ts) since EXTRACT(part FROM timestamptz) is session-TZ-
   * sensitive (confirmed live: EXTRACT(HOUR FROM tstz) changes across
   * session TZ, EXTRACT(HOUR FROM naive timestamp) does not); mysql
   * DATETIME is tz-naive by construction (confirmed live: HOUR(dt)
   * unchanged across session time_zone) and mongo BSON Date is
   * UTC-epoch by construction — neither needs a parallel pin.
   * date_add's month/year clamp: confirmed live
   * (apps/worker/scripts/month-add-clamp-probe.ts) that native interval
   * arithmetic ALREADY clamps to the last valid day of the target month
   * on both mysql (DATE_ADD) and postgres (+ INTERVAL) — matching
   * mongo's native $dateAdd — so every unit branch (including
   * month/year) uses native interval arithmetic uniformly; no
   * hand-rolled divmod/day-clamp arithmetic is needed.
   * date_add's output format: a single native to_char/DATE_FORMAT call
   * per branch (not compileToDateSql's extract+CONCAT pattern) — both
   * `to_char`/`date_format` confirmed absent from guardrails'
   * FORBIDDEN_KEYWORDS (packages/guardrails/src/sql/validator.ts), and
   * their format-string literal args are opaque string tokens the
   * tokenizer never scans, so this is guardrails-safe and avoids
   * re-embedding the "shifted" value 6 times (mysql's positional `?`
   * recompute-per-occurrence discipline would otherwise multiply
   * baseC()/nSql() calls ~7-8x per branch).
   */
  function compileDateCoerceSql(arg: () => string): string {
    const textVal = () => (dialect === "mysql" ? `CAST(${arg()} AS CHAR)` : `CAST(${arg()} AS text)`);
    const isoShaped = () =>
      dialect === "mysql" ? `${textVal()} REGEXP '${ISO_DATE_LITERAL_RE.source}'` : `${textVal()} ~ '${ISO_DATE_LITERAL_RE.source}'`;
    if (dialect === "mysql") {
      return `(CASE WHEN ${arg()} IS NULL THEN NULL WHEN NOT (${isoShaped()}) THEN NULL ELSE ${arg()} END)`;
    }
    const typeExpr = () => `CAST(pg_typeof(${arg()}) AS text)`;
    const isTemporal = () => `${typeExpr()} IN ('date', 'timestamp without time zone', 'timestamp with time zone')`;
    // Cast via text, never `CAST(${arg()} AS timestamptz)` directly: postgres
    // type-checks EVERY CASE branch at parse time regardless of whether the
    // WHEN condition is ever true at runtime (confirmed live — a `double
    // precision`-typed arg hard-errored "cannot cast type double precision
    // to timestamp with time zone" on the isTemporal branch even though that
    // branch's WHEN is always false for a non-temporal column). `text` has a
    // defined, always-valid cast to/from every builtin type, so routing
    // through `textVal()` makes both branches statically castable for ANY
    // argument type; the isTemporal branch's runtime content is only ever a
    // temporal value's own text rendering (always parseable), and the
    // isoShaped branch's WHEN already regex-validated the text shape before
    // this CAST runs.
    return (
      `(CASE WHEN ${arg()} IS NULL THEN NULL ` +
      `WHEN ${isTemporal()} THEN CAST(${textVal()} AS timestamptz) ` +
      `WHEN ${isoShaped()} THEN CAST(${textVal()} AS timestamptz) ` +
      `ELSE NULL END)`
    );
  }

  type DatePart = "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND" | "QUARTER";

  function datePartSql(coercedSql: string, part: DatePart): string {
    return dialect === "mysql" ? `${part}(${coercedSql})` : `EXTRACT(${part} FROM ${coercedSql})`;
  }

  function isoWeekdaySql(coercedSql: string): string {
    return dialect === "mysql" ? `(WEEKDAY(${coercedSql}) + 1)` : `EXTRACT(ISODOW FROM ${coercedSql})`;
  }

  /**
   * (CASE WHEN unit()='name' THEN body() ... ELSE NULL END) — unit()/
   * body() are closures re-invoked once per branch (recompute-per-
   * occurrence, mysql `?` safety); an unrecognized or NULL unit resolves
   * to NULL via the implicit ELSE, so date_diff/date_add need no
   * separate "is this a known unit" guard.
   */
  function unitDispatchSql(unitSql: () => string, branches: Array<[string, () => string]>): string {
    const whens = branches.map(([name, bodyFn]) => `WHEN ${unitSql()} = '${name}' THEN ${bodyFn()}`).join(" ");
    return `(CASE ${whens} ELSE NULL END)`;
  }

  type DateUnitWord = "year" | "month" | "day" | "hour" | "minute" | "second";

  function compileDateFnSql(expr: Extract<Expr, { kind: "call" }>, params: ParamSink): string {
    const arg = (i: number) => compileExpr(expr.args[i]!, params);

    switch (expr.fn) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
      case "quarter": {
        const partMap = {
          year: "YEAR", month: "MONTH", day: "DAY", hour: "HOUR", minute: "MINUTE", second: "SECOND", quarter: "QUARTER",
        } as const;
        return datePartSql(compileDateCoerceSql(() => arg(0)), partMap[expr.fn]);
      }
      case "weekday":
        return isoWeekdaySql(compileDateCoerceSql(() => arg(0)));
      case "date_diff": {
        const startC = () => compileDateCoerceSql(() => arg(0));
        const endC = () => compileDateCoerceSql(() => arg(1));
        const epochDiffSecondsSql = () =>
          dialect === "mysql"
            ? `TIMESTAMPDIFF(SECOND, ${startC()}, ${endC()})`
            : `EXTRACT(EPOCH FROM (${endC()} - ${startC()}))`;
        const truncDiv = (divisor: number) => {
          const e = epochDiffSecondsSql();
          return dialect === "mysql" ? `TRUNCATE((${e}) / ${divisor}, 0)` : `TRUNC(CAST((${e}) / ${divisor} AS numeric), 0)`;
        };
        const unitSql = () => arg(2);
        const body = unitDispatchSql(unitSql, [
          ["year", () => `(${datePartSql(endC(), "YEAR")} - ${datePartSql(startC(), "YEAR")})`],
          [
            "month",
            () =>
              `((${datePartSql(endC(), "YEAR")} - ${datePartSql(startC(), "YEAR")}) * 12 + ` +
              `(${datePartSql(endC(), "MONTH")} - ${datePartSql(startC(), "MONTH")}))`,
          ],
          ["day", () => truncDiv(86400)],
          ["hour", () => truncDiv(3600)],
          ["minute", () => truncDiv(60)],
          ["second", () => truncDiv(1)],
        ]);
        // Explicit guard even though EXTRACT/TIMESTAMPDIFF/TRUNC(ATE) all
        // independently propagate NULL natively (confirmed by this file's
        // own prior batch-4 comments on TRUNCATE(NULL,0)/TRUNC(CAST(NULL
        // AS numeric),0)) — kept explicit per this batch's "guard unless
        // proven by a live case" protocol; the NULL-input agreement case
        // doubles as that proof.
        return `(CASE WHEN ${startC()} IS NULL OR ${endC()} IS NULL THEN NULL ELSE ${body} END)`;
      }
      case "date_add": {
        const baseC = () => compileDateCoerceSql(() => arg(0));
        const nSql = () => arg(1);
        const unitSql = () => arg(2);
        const shiftedSql = (unitWord: DateUnitWord) => () =>
          dialect === "mysql"
            ? `DATE_ADD(${baseC()}, INTERVAL (${nSql()}) ${unitWord.toUpperCase()})`
            : `(${baseC()} + (${nSql()}) * INTERVAL '1 ${unitWord}')`;
        const formatted = (unitWord: DateUnitWord) => () => {
          const shifted = shiftedSql(unitWord)();
          return dialect === "mysql"
            ? `DATE_FORMAT(${shifted}, '%Y-%m-%dT%H:%i:%sZ')`
            : `to_char(${shifted}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
        };
        // bodyFn/nNullCheckSql are kept as closures and invoked ONLY inline
        // inside the final template below, in left-to-right text order —
        // NOT hoisted into `const`s computed beforehand. A prior version
        // did `const body = unitDispatchSql(...)` (pushing all 12 of its
        // unit/n params) BEFORE computing the null-guard's own placeholder,
        // even though the null-guard's "?" appears TEXTUALLY BEFORE body's
        // 12 "?"s in the returned string — a third live instance of the
        // arg(n)-after-intermediate-SQL desync pattern (quotient,
        // compileTrueTypeSql, now this): the params array ends up in
        // execution order while the SQL text's placeholders are in a
        // different (textual) order, silently binding every value to the
        // wrong placeholder. Confirmed live: mysql agreement cases for
        // date_add's month/year-clamp contracts all returned 0 rows instead
        // of 1 (the unit/n values were bound to the null-guard slot and
        // vice-versa). Calling both closures inline, in the same order they
        // appear in the template, makes push order and text order match by
        // construction.
        const bodyFn = () =>
          unitDispatchSql(unitSql, [
            ["year", formatted("year")],
            ["month", formatted("month")],
            ["day", formatted("day")],
            ["hour", formatted("hour")],
            ["minute", formatted("minute")],
            ["second", formatted("second")],
          ]);
        // postgres only: a bare `${nSql()} IS NULL` gave postgres no typed
        // context to infer that placeholder's type from at all (confirmed
        // live — "could not determine data type of parameter $N") whenever
        // `n` is a literal, since every OTHER occurrence of `n` sits inside
        // an arithmetic context (`(...) * INTERVAL '1 unit'`) that infers
        // fine on its own and shares nothing with this recompiled-per-call
        // placeholder (see the arg(n)-recompile-per-occurrence discipline).
        // An explicit numeric cast gives this standalone occurrence its own
        // type context; mysql's `?` placeholders never hit this class of
        // error, so left as a plain bare check there.
        const nNullCheckSql = () => (dialect === "mysql" ? nSql() : `CAST(${nSql()} AS numeric)`);
        return `(CASE WHEN ${baseC()} IS NULL OR ${nNullCheckSql()} IS NULL THEN NULL ELSE ${bodyFn()} END)`;
      }
      default:
        // Unreachable — callers only route here via DATE_CALL_FNS.has(expr.fn).
        throw new Error(`compileDateFnSql: unhandled date fn "${expr.fn}"`);
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
   * vocabulary (same token set as residualEval.ts's compileDateFormatToRegex
   * — the two must stay in agreement) into: a `^...$` shape-validation regex
   * (digit-class placeholders for tokens, regex-escaped literal separator
   * chars), pushed as a bound param and REGEXP/~-tested (boolean only, no
   * capture groups needed — see below for why); and each token's fixed
   * character OFFSET within the matched text. Every portable token has a
   * FIXED width in the matched text equal to its own width in the format
   * string (YYYY=4, MM/DD/HH/mm/ss=2) and every literal separator
   * contributes exactly 1 char both in the format string and in the
   * matched text — so a token's offset in the INPUT TEXT is always
   * identical to its offset in the FORMAT STRING itself, a compile-time
   * constant requiring no runtime capture-group extraction at all. This
   * sidesteps mysql's REGEXP_SUBSTR having no group-index parameter (the
   * same gap that makes regex_extract's group>=1 case non-pushable there)
   * entirely: SUBSTRING(text, offset, width) at a compile-time-known
   * offset works identically on mysql and postgres, no capture groups
   * needed.
   */
  function compileDateFormatSql(format: string): {
    validateRe: string;
    parts: { token: DateFormatToken; offset: number; width: number }[];
  } {
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
        // Regex-escaped for a BOUND param value (transmitted to the regex
        // engine as raw bytes, not re-parsed as a SQL string literal first)
        // — plain single-backslash regex escaping, not the SQL-literal
        // double-escaping numRe/compileLooksNumericSql need for their
        // INLINE-text mysql patterns.
        pattern += format[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i += 1;
      }
    }
    return { validateRe: `^${pattern}$`, parts };
  }

  /**
   * Batch 6 (Phase 8b-2) — Cleaning vocabulary, mysql/postgres arm. Full
   * contract in docs/decisions.md's batch 6 entry and residualEval.ts's
   * evalCleanFn doc comment (the two must stay in agreement); this comment
   * covers only the SQL construction strategy and the genuine dialect
   * divergences.
   *
   * - regex_match: native REGEXP_LIKE (mysql, ICU regex engine) / `~`/`~*`
   *   (postgres). NULL-propagates natively on either dialect when text or
   *   pattern is NULL — no explicit guard needed.
   * - regex_extract: mysql's REGEXP_SUBSTR has no capture-group-index
   *   parameter (only whole-match extraction) — the genuine capability
   *   gap. Declared entirely non-pushable on mysql in FN_PUSHABILITY (not
   *   just the group>=1 case — FN_PUSHABILITY is a binary per-fn-per-
   *   dialect table with no per-argument-value granularity, so the
   *   pushable whole-match case can't be split out on its own) — this
   *   throws defensively here, unreachable through the normal pushdown
   *   path (same precedent as mongo.ts's upper/lower — see its doc
   *   comment). Postgres: group=0 (whole match) wraps the user's pattern
   *   in one extra outer capturing group at the SQL level (`'(' ||
   *   pattern || ')'`, built from the bound pattern param via `||`
   *   concatenation, not re-parsed) and uses `substring(text from
   *   wrapped)` — robust regardless of how many internal subgroups the
   *   user's own pattern already has, since the added outer group always
   *   spans the whole match. group>=1 uses `(regexp_match(text,
   *   pattern))[group]` directly. Both forms NULL-propagate natively (no
   *   match, or an out-of-bounds group index, -> NULL via postgres's
   *   native array-indexing-out-of-bounds behavior).
   * - regex_replace: replaces ALL matches on both dialects — mysql's
   *   REGEXP_REPLACE is already global by default (occurrence=0), postgres
   *   requires the explicit 'g' flag (non-global by default) — a genuine
   *   divergence, homogenized by always passing 'g' on postgres. Mongo has
   *   no regex-replace pipeline stage at all -> non-pushable there
   *   (handled in mongo.ts). `replacement`'s backreference syntax is
   *   pinned to postgres-native `\1`-`\9` (no translation needed there)
   *   but mysql's REGEXP_REPLACE follows ICU replacement syntax (`$1`-`$9`,
   *   literal `$` doubled as `$$`) — since `replacement` is enforced
   *   literal at parse time (LITERAL_STRING_ARG_INDEXES in expression.ts),
   *   this translation happens once at COMPILE time on the literal JS
   *   string (not re-derived from SQL text), reusing the exact same
   *   2-step escape-then-translate transform as residualEval.ts's
   *   translateBackreferences (JS's own `.replace()`-replacement-string
   *   `$N`/`$$` syntax is identical to ICU's).
   * - canonicalize: REGEXP_REPLACE-based whitespace-run collapse (to a
   *   single space) then a border trim, reusing the exact same ASCII_WS
   *   set as batch 3's `trim` (not re-derived).
   * - strip_accents: non-pushable on every dialect (no native NFD-
   *   normalize-and-strip-combining-marks primitive on mysql/postgres) —
   *   throws defensively here too, same precedent.
   * - parse_date: the portable format token string is enforced literal at
   *   parse time, so both the shape-validation regex and each token's
   *   fixed text offset are computed entirely at COMPILE time (see
   *   compileDateFormatSql's doc comment) — no native STR_TO_DATE/
   *   TO_TIMESTAMP parsing is used at all, sidestepping any uncertainty
   *   about whether those natively ERROR vs return NULL on an
   *   out-of-range field (a hard ERROR would abort the whole query, unlike
   *   every other function in this file). Each field is extracted via a
   *   compile-time-constant-offset SUBSTRING + CAST-to-integer and
   *   explicitly bounds-checked (same basic bounds check as to_date /
   *   residualEval's parse_date — not full days-in-month/leap-year
   *   validation), then reassembled into the same ISO-8601 shape
   *   to_date/the date-part functions already consume.
   * - parse_number: SQL-level REPLACE-based separator normalization
   *   (strip the non-decimal separator, swap a "," decimal separator to
   *   "."), then the same TRIM+numeric-regex-match+overflow-guarded CAST
   *   strategy as to_number's coerceNumberSql (reusing the hoisted `numRe`
   *   constant directly so the two can't silently drift apart) — except
   *   scientific notation is explicitly rejected first (disclosed
   *   scope-narrowing vs. to_number, matching residualEval's same
   *   contract) rather than exponent-magnitude-guarded through.
   */
  function compileCleanFnSql(expr: Extract<Expr, { kind: "call" }>, params: ParamSink): string {
    const arg = (i: number) => compileExpr(expr.args[i]!, params);
    const asText = (i: number) => (dialect === "mysql" ? `CAST(${arg(i)} AS CHAR)` : `CAST(${arg(i)} AS text)`);
    switch (expr.fn) {
      case "regex_match": {
        const caseInsensitiveArg = expr.args[2];
        const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
        if (dialect === "mysql") {
          return `REGEXP_LIKE(${arg(0)}, ${arg(1)}, ${caseInsensitive ? "'i'" : "'c'"})`;
        }
        return caseInsensitive ? `(${arg(0)} ~* ${arg(1)})` : `(${arg(0)} ~ ${arg(1)})`;
      }
      case "regex_extract": {
        if (dialect === "mysql") {
          throw new Error(
            `compileCleanFnSql: "regex_extract" is not pushable on mysql (FN_PUSHABILITY.regex_extract.mysql is false) — this call should have been routed to residual, not compiled`,
          );
        }
        const groupArg = expr.args[2];
        const group =
          groupArg !== undefined && groupArg.kind === "literal" && typeof groupArg.value === "number"
            ? Math.trunc(groupArg.value)
            : 0;
        if (group === 0) {
          return `substring(${arg(0)} from ('(' || ${arg(1)} || ')'))`;
        }
        return `(regexp_match(${arg(0)}, ${arg(1)}))[${group}]`;
      }
      case "regex_replace": {
        const caseInsensitiveArg = expr.args[3];
        const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
        const replacementArg = expr.args[2]!;
        if (replacementArg.kind !== "literal" || typeof replacementArg.value !== "string") {
          // Unreachable — enforced literal by LITERAL_STRING_ARG_INDEXES in expression.ts.
          throw new Error(`compileCleanFnSql: "regex_replace" replacement argument must be a literal string`);
        }
        if (dialect === "mysql") {
          const icuReplacement = replacementArg.value.replace(/\$/g, "$$$$").replace(/\\([1-9])/g, "$$$1");
          const replacementSql = params.push(icuReplacement);
          // occurrence=0 means replace ALL matches (mysql's REGEXP_REPLACE
          // is already global by default); pos=1 is the start position;
          // match_type is the 6th positional arg and requires pos/
          // occurrence to be spelled out to reach it.
          return `REGEXP_REPLACE(${arg(0)}, ${arg(1)}, ${replacementSql}, 1, 0, ${caseInsensitive ? "'i'" : "'c'"})`;
        }
        // postgres's regexp_replace is non-global by default (opposite of
        // mysql) — the explicit 'g' flag is REQUIRED here to match the
        // "replace all matches" contract.
        return `regexp_replace(${arg(0)}, ${arg(1)}, ${arg(2)}, ${caseInsensitive ? "'gi'" : "'g'"})`;
      }
      case "canonicalize": {
        const collapsed = () =>
          dialect === "mysql"
            ? `REGEXP_REPLACE(${arg(0)}, '[${ASCII_WS}]+', ' ')`
            : `regexp_replace(${arg(0)}, '[${ASCII_WS}]+', ' ', 'g')`;
        const trimBorders = (sql: string) =>
          dialect === "mysql" ? `REGEXP_REPLACE(${sql}, '^ +| +$', '')` : `regexp_replace(${sql}, '^ +| +$', '', 'g')`;
        return trimBorders(collapsed());
      }
      case "strip_accents":
        // Non-pushable on every dialect (no native NFD-normalize +
        // combining-mark-strip primitive on mysql/postgres) — unreachable
        // through the normal pushdown path; FN_PUSHABILITY.strip_accents.
        // {mysql,postgres} are both false (see types.ts). Same defensive-
        // throw precedent as mongo.ts's upper/lower.
        throw new Error(
          `compileCleanFnSql: "strip_accents" is not pushable on ${dialect} (FN_PUSHABILITY.strip_accents.${dialect} is false) — this call should have been routed to residual, not compiled`,
        );
      case "parse_date": {
        const formatArg = expr.args[1]!;
        if (formatArg.kind !== "literal" || typeof formatArg.value !== "string") {
          // Unreachable — enforced literal by LITERAL_STRING_ARG_INDEXES in expression.ts.
          throw new Error(`compileCleanFnSql: "parse_date" format argument must be a literal string`);
        }
        const { validateRe, parts } = compileDateFormatSql(formatArg.value);
        const textSql = () => arg(0);
        const matches = () =>
          dialect === "mysql" ? `${textSql()} REGEXP ${params.push(validateRe)}` : `${textSql()} ~ ${params.push(validateRe)}`;
        const substrAt = (offset: number, width: number) => () =>
          dialect === "mysql"
            ? `CAST(SUBSTRING(${textSql()}, ${offset + 1}, ${width}) AS SIGNED)`
            : `CAST(SUBSTRING(${textSql()} FROM ${offset + 1} FOR ${width}) AS integer)`;
        const defaultPart: Record<DateFormatToken, () => string> = {
          YYYY: () => "1970",
          MM: () => "1",
          DD: () => "1",
          HH: () => "0",
          mm: () => "0",
          ss: () => "0",
        };
        const partSql: Record<DateFormatToken, () => string> = { ...defaultPart };
        for (const p of parts) partSql[p.token] = substrAt(p.offset, p.width);
        const boundsOk = () =>
          `(${partSql.MM()} BETWEEN 1 AND 12 AND ${partSql.DD()} BETWEEN 1 AND 31 AND ` +
          `${partSql.HH()} BETWEEN 0 AND 23 AND ${partSql.mm()} BETWEEN 0 AND 59 AND ${partSql.ss()} BETWEEN 0 AND 59)`;
        const asStr = (sql: string) => (dialect === "mysql" ? `CAST(${sql} AS CHAR)` : `CAST(${sql} AS text)`);
        const pad = (sql: string, width: number) => `LPAD(${asStr(sql)}, ${width}, '0')`;
        const iso = () =>
          `CONCAT(${pad(partSql.YYYY(), 4)}, '-', ${pad(partSql.MM(), 2)}, '-', ${pad(partSql.DD(), 2)}, 'T', ` +
          `${pad(partSql.HH(), 2)}, ':', ${pad(partSql.mm(), 2)}, ':', ${pad(partSql.ss(), 2)}, 'Z')`;
        return `(CASE WHEN ${textSql()} IS NULL THEN NULL WHEN NOT (${matches()}) THEN NULL WHEN NOT ${boundsOk()} THEN NULL ELSE ${iso()} END)`;
      }
      case "parse_number": {
        const decSepSql = () => (expr.args[1] !== undefined ? arg(1) : `'.'`);
        const thousandsSepSql = () => `(CASE WHEN ${decSepSql()} = '.' THEN ',' ELSE '.' END)`;
        const strippedSql = () => `REPLACE(TRIM(${asText(0)}), ${thousandsSepSql()}, '')`;
        const normalizedSql = () =>
          `(CASE WHEN ${decSepSql()} = '.' THEN ${strippedSql()} ELSE REPLACE(${strippedSql()}, ${decSepSql()}, '.') END)`;
        const matches = () => (dialect === "mysql" ? `${normalizedSql()} REGEXP ${numRe}` : `${normalizedSql()} ~ ${numRe}`);
        const hasSciNotation = () =>
          dialect === "mysql" ? `LOWER(${normalizedSql()}) REGEXP '[e]'` : `LOWER(${normalizedSql()}) ~ '[e]'`;
        const asDouble = () =>
          dialect === "mysql" ? `CAST(${normalizedSql()} AS DOUBLE)` : `CAST(${normalizedSql()} AS double precision)`;
        return (
          `(CASE WHEN ${decSepSql()} NOT IN ('.', ',') THEN NULL ` +
          `WHEN ${arg(0)} IS NULL THEN NULL ` +
          `WHEN ${hasSciNotation()} THEN NULL ` +
          `WHEN NOT (${matches()}) THEN NULL ` +
          `WHEN CHAR_LENGTH(${normalizedSql()}) > 320 THEN NULL ` +
          `ELSE ${asDouble()} END)`
        );
      }
      default:
        // Unreachable — callers only route here via CLEAN_CALL_FNS.has(expr.fn).
        throw new Error(`compileCleanFnSql: unhandled clean fn "${expr.fn}"`);
    }
  }

  function compileExpr(expr: Expr, params: ParamSink): string {
    switch (expr.kind) {
      case "field":
        return quoteIdent(expr.name);
      case "literal":
        // A null literal is emitted as the raw SQL `NULL` keyword, never
        // parameterized. This sidesteps the whole ambiguous-bind-parameter
        // problem the other branches of this file work around with an
        // explicit CAST (see castAmbiguousLiteral's doc comment above): an
        // extended-protocol `$n`/`?` placeholder must have its type pinned
        // before execution and postgres can't always infer one (a bare
        // `SELECT $1 AS "col"` with no other context is exactly the "could
        // not determine data type of parameter $1" failure) — but a literal
        // `NULL` keyword is untyped/"unknown" the same way a bare string
        // literal is, so postgres resolves it from surrounding context
        // (CASE branches, COALESCE siblings, a bare top-level SELECT)
        // exactly like it already does for non-date-shaped string literals,
        // with no CAST needed on either dialect.
        if (expr.value === null) return "NULL";
        return params.push(expr.value);
      case "binary":
        return `(${compileExpr(expr.left, params)} ${expr.op} ${compileExpr(expr.right, params)})`;
      case "call": {
        if (expr.fn === "concat") return `CONCAT(${expr.args.map((a) => compileExpr(a, params)).join(", ")})`;
        if (expr.fn === "coalesce") return `COALESCE(${expr.args.map((a) => compileExpr(a, params)).join(", ")})`;
        if (expr.fn === "contains") {
          const target = compileExpr(expr.args[0]!, params);
          const valueArg = expr.args[1]!;
          const caseInsensitiveArg = expr.args[2];
          const caseInsensitive = caseInsensitiveArg?.kind === "literal" && caseInsensitiveArg.value === true;
          let pattern: string;
          if (valueArg.kind === "literal") {
            pattern = params.push(`%${String(valueArg.value)}%`);
          } else {
            pattern = `CONCAT('%', ${compileExpr(valueArg, params)}, '%')`;
          }
          return compileContainsSql(target, pattern, caseInsensitive);
        }
        if (expr.fn === "is_null") return `${compileExpr(expr.args[0]!, params)} IS NULL`;
        if (expr.fn === "is_not_null") return `${compileExpr(expr.args[0]!, params)} IS NOT NULL`;
        if (MATH_CALL_FNS.has(expr.fn)) return compileMathFnSql(expr, params);
        if (TEXT_CALL_FNS.has(expr.fn)) return compileTextFnSql(expr, params);
        if (COERCION_CALL_FNS.has(expr.fn)) return compileCoercionFnSql(expr, params);
        if (DATE_CALL_FNS.has(expr.fn)) return compileDateFnSql(expr, params);
        if (CLEAN_CALL_FNS.has(expr.fn)) return compileCleanFnSql(expr, params);
        // Fix 2 (Item 3 follow-up audit), extended finding: fixing the
        // param-ordering desync above let compilation for is_number(<a bare
        // literal>) succeed far enough on postgres to hit a DIFFERENT,
        // previously-masked inference failure — pg_typeof(anyelement) is
        // polymorphic, so `pg_typeof($1) ...`/`$1 IS NOT NULL` give
        // postgres no concrete type to bind $1 to at all when the argument
        // is a bare literal with no other typed context (confirmed live:
        // "could not determine data type of parameter $1"). A field
        // reference never hits this (the column already has a declared
        // type). Rather than a cast workaround (there's no single type
        // that's simultaneously right for is_number's numeric types and
        // is_text's text types), short-circuit at compile time: a
        // literal's number/text-ness is already statically known from its
        // JS value (same true-type semantics as mongo's $isNumber/$type
        // and residualEval's typeof checks), so route it straight to a
        // literal boolean instead of ever reaching compileTrueTypeSql's
        // runtime pg_typeof/JSON_TYPE check.
        if (expr.args[0]!.kind === "literal" && (expr.fn === "is_number" || expr.fn === "is_text")) {
          const isNumberLiteral = typeof expr.args[0]!.value === "number";
          const result = expr.fn === "is_number" ? isNumberLiteral : typeof expr.args[0]!.value === "string";
          return params.push(result);
        }
        // Fix 2 (Item 3 follow-up audit): a closure, not a precomputed
        // string — is_number/is_text route through compileTrueTypeSql,
        // which embeds this arg twice and needs a fresh recompile per
        // embed on mysql (see its doc comment). looks_numeric only embeds
        // its arg once, so a single `arg0()` call is fine there.
        const arg0 = () => compileExpr(expr.args[0]!, params);
        if (expr.fn === "is_number") return compileTrueTypeSql(arg0, "number");
        if (expr.fn === "is_text") return compileTrueTypeSql(arg0, "text");
        // looks_numeric
        return compileLooksNumericSql(arg0());
      }
      case "comparison": {
        const opSql: Record<typeof expr.op, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
        let leftSql = compileExpr(expr.left, params);
        let rightSql = compileExpr(expr.right, params);
        // Fix 1/2 (Phase 8b-2, batch 0): same mysql BINARY-forcing as
        // compileConditionAgainstTarget above, for the general (non-flat-
        // AND-of-conditions) Expr comparison path — reachable from
        // hand-authored/Copilot-proposed or/not/nested filter and having
        // shapes that exprToConditions can't flatten. Type-guarded the only
        // way statically possible without column-type/schema knowledge:
        // an operand that's a literal has a known JS type, so force BINARY
        // on that operand specifically when it's a string literal. A
        // field-vs-field (or otherwise non-literal-on-either-side)
        // comparison can't be proven a string comparison at compile time —
        // left unforced, a disclosed limitation (not producible by either
        // editor today; only reachable via hand-authored/Copilot configs).
        // Loose end 1 (Phase 8b-2, batch 0): confirmed live — `name =
        // other_name` (both fields) DOES reach this branch (0 residual
        // fallback) and DOES diverge on mysql the same way literal
        // comparisons did before Fix 1/2. Deliberately left unfixed: unlike
        // a literal operand, a field has no static JS type here, so forcing
        // BINARY unconditionally would silently corrupt a numeric
        // field-vs-field comparison (e.g. `age > age2`) the same way it
        // would for a literal number — see docs/decisions.md's "Loose end
        // 1" writeup for the full disclosure and the join-predicate note.
        if (dialect === "mysql") {
          if (expr.left.kind === "literal" && typeof expr.left.value === "string") leftSql = `BINARY ${leftSql}`;
          if (expr.right.kind === "literal" && typeof expr.right.value === "string") rightSql = `BINARY ${rightSql}`;
        }
        return `(${leftSql} ${opSql[expr.op]} ${rightSql})`;
      }
      case "logical": {
        if (expr.op === "not") return `(NOT ${compileExpr(expr.args[0]!, params)})`;
        const joiner = expr.op === "and" ? " AND " : " OR ";
        return `(${expr.args.map((a) => compileExpr(a, params)).join(joiner)})`;
      }
      case "conditional": {
        const castDateStrings = planDateStringCast([...expr.branches.map((b) => b.then), expr.else]);
        const whens = expr.branches
          .map(
            (b) =>
              `WHEN ${compileExpr(b.when, params)} THEN ${castAmbiguousLiteral(b.then, compileExpr(b.then, params), castDateStrings)}`,
          )
          .join(" ");
        return `(CASE ${whens} ELSE ${castAmbiguousLiteral(expr.else, compileExpr(expr.else, params), castDateStrings)} END)`;
      }
    }
  }

  function combineAnd(fragments: string[]): string | null {
    return fragments.length ? fragments.map((p) => `(${p})`).join(" AND ") : null;
  }

  return {
    dialect,
    quoteIdent,
    placeholder,
    compileExpr,
    compileCondition,
    compileConditionAgainstTarget,
    compileAggAccumulator,
    combineAnd,
  };
}
