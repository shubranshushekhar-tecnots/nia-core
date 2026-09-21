import { z } from "zod";

/**
 * Restricted expression grammar for a transform node's "computed field"
 * step (nodeConfig.ts's ComputedFieldStep) and, since Phase 8b-1, for any
 * boolean condition (FilterStep.expr, AggregateStep.having) too — one
 * grammar, one compileExpr path, one place to validate. Parsed once, in
 * the canvas UI, into this AST — never stored as a raw string in
 * GraphDoc — so the pushdown compiler (pushdown.ts, same package so both
 * apps/worker and apps/web can import it) can walk a known shape instead
 * of re-parsing/trusting user text at compile time.
 *
 * Grammar (intentionally small — anything outside this is a parse error,
 * surfaced as an inline UI error rather than silently saved):
 *   or         := and (("or") and)*
 *   and        := not (("and") not)*
 *   not        := "not" not | comparison
 *   comparison := arith (("=" | "!=" | "<" | "<=" | ">" | ">=") arith)?
 *   arith      := term (("+" | "-") term)*
 *   term       := unary (("*" | "/") unary)*
 *   unary      := "-" unary | factor      (Phase 8b-2b: folds into a negative
 *                                          literal when the operand is one, else
 *                                          desugars to `0 - operand`, a plain binary)
 *   factor     := NUMBER | STRING | "true" | "false" | fieldRef | call
 *               | "if(" or "," or "," or ")"
 *               | "ifs(" or "," or ("," or "," or)* "," or ")"
 *               | "switch(" or ("," or "," or)+ "," or ")"
 *               | "(" or ")"
 *   fieldRef   := IDENT | "[" STRING "]"        (bracket form for names with spaces/symbols)
 *   call       := CALL_FN "(" or ("," or)* ")"    (arity per-function, see CALL_ARITY)
 *
 * CALL_FN (Phase 8b-2, batch 0) = concat|coalesce|contains|is_null|
 *   is_not_null|is_number|is_text|looks_numeric. Batch 1 adds the DAX-
 *   derived Math-core vocabulary: divide|round|round_up|round_down|abs|
 *   ceil|floor|round_to_multiple|mod|power|sqrt|sign|quotient|int|trunc.
 *   Batch 2 adds the Math-remainder vocabulary: exp|ln|log. ln(x) and the
 *   no-base form of log(x) return NULL for x<=0 (homogenized by explicit
 *   guard, same "declared, not native-error" treatment as batch 1's
 *   divide/round — postgres's ln()/mongo's $ln both throw a runtime error
 *   for x<=0 natively, which would fail the whole query rather than null
 *   out one row; mysql's native LN already returns NULL, so the guard
 *   just makes the other two dialects + residual agree with it). log(x,
 *   base) additionally returns NULL when base<=0 or base=1. See
 *   docs/decisions.md's batch 2 entry for the full per-engine-native-
 *   behavior writeup.
 *
 * Every node is either scalar- or boolean-typed (see typeOfExpr below).
 * Arithmetic/comparison operands must not be boolean; logical operands
 * must all be boolean; a conditional's branches (every `then` + the
 * `else`) must all agree on one type. Enforced twice: primarily by this
 * parser (rejects ill-typed source as a parse error, same as any other
 * grammar violation), and defense-in-depth by ExprSchema's superRefine
 * for the two paths that don't go through this parser — the legacy
 * FilterCondition upcast (nodeConfig.ts) and Copilot-proposed ops built
 * as JSON directly.
 *
 * `if`/`ifs`/`switch` are surface sugar, not separate AST node kinds —
 * all three desugar into the one n-ary `conditional` node at parse time
 * (buildConditional below), matching CASE WHEN / $switch's native n-ary
 * shape so emitSql/emitMongo need no flatten/re-nest step.
 */

export interface ExprFieldRef {
  kind: "field";
  name: string;
}
export interface ExprLiteral {
  kind: "literal";
  value: string | number | boolean;
}
export interface ExprBinary {
  kind: "binary";
  op: "+" | "-" | "*" | "/";
  left: Expr;
  right: Expr;
}
export interface ExprCall {
  kind: "call";
  fn:
    | "concat"
    | "coalesce"
    | "contains"
    | "is_null"
    | "is_not_null"
    | "is_number"
    | "is_text"
    | "looks_numeric"
    // Phase 8b-2, batch 1: DAX-derived Math-core vocabulary. All scalar
    // (numeric)-typed, per typeOfExpr's default below.
    | "divide"
    | "round"
    | "round_up"
    | "round_down"
    | "abs"
    | "ceil"
    | "floor"
    | "round_to_multiple"
    | "mod"
    | "power"
    | "sqrt"
    | "sign"
    | "quotient"
    | "int"
    | "trunc"
    // Phase 8b-2, batch 2: Math-remainder vocabulary. Scalar-typed.
    | "exp"
    | "ln"
    | "log"
    // Phase 8b-2, batch 3: DAX-derived Text-core vocabulary (+ split, not
    // itself a DAX function — see ops/types.ts's FN_PUSHABILITY doc and
    // docs/decisions.md's batch 3 entry for the full per-fn contract).
    // All scalar (text)-typed except find/len (numeric) — typeOfExpr
    // still returns "scalar" for both since this codebase's ExprValueType
    // only distinguishes boolean vs scalar, not text vs numeric.
    | "upper"
    | "lower"
    | "trim"
    | "left"
    | "right"
    | "mid"
    | "len"
    | "substitute"
    | "find"
    | "rept"
    | "split"
    // Phase 8b-2, batch 4: Coercion vocabulary. `exact` was proposed but
    // dropped — see docs/decisions.md's batch 4 entry: batch 0 already
    // forces mysql's `=`/comparison operands to BINARY (case-sensitive)
    // for string literals, and postgres/mongo/residual are natively
    // case-sensitive by default, so `exact` would add nothing beyond the
    // now-fixed `=`. All 6 remaining functions are scalar-typed (per
    // typeOfExpr's default below) — including `to_boolean`, which can
    // yield NULL (unlike BOOLEAN_CALL_FNS's members, which never do);
    // deliberately NOT added to BOOLEAN_CALL_FNS (see that set's doc
    // comment) to avoid expanding the type system beyond this batch's
    // scope.
    | "to_number"
    | "to_integer"
    | "to_text"
    | "format_number"
    | "to_boolean"
    | "to_date"
    // Phase 8b-2, batch 5: Date-part vocabulary. year/month/day/hour/
    // minute/second/quarter/weekday take a single date-shaped argument
    // (a real typed date/timestamp/timestamptz column, or an ISO-8601
    // string — see sqlShared.ts's compileDateCoerceSql doc comment for
    // the full coercion contract, and docs/decisions.md's batch 5 entry
    // for the ISO-8601/ISO-weekday/UTC-everywhere pins). date_diff(start,
    // end, unit) / date_add(date, n, unit) take a 3rd `unit` argument —
    // one of 'year'|'month'|'day'|'hour'|'minute'|'second' — expected to
    // be a string, dispatched at runtime via an explicit branch over each
    // known unit value (not required to be a literal at compile time; see
    // sqlShared.ts's unitDispatchSql). All 10 are scalar-typed (dates are
    // represented as plain scalar values in this grammar, same as text/
    // numbers — there is no separate date value type).
    | "year"
    | "month"
    | "day"
    | "hour"
    | "minute"
    | "second"
    | "quarter"
    | "weekday"
    | "date_diff"
    | "date_add"
    // Phase 8b-2, batch 6: Cleaning vocabulary. regex_match/regex_extract/
    // regex_replace's `pattern` is enforced LITERAL (compile-time constant,
    // never runtime-dynamic) but its CONTENT is NOT validated or restricted
    // to any subset — it is passed through unmodified to 4 genuinely
    // different regex engines (JS RegExp/residual, mysql's ICU engine,
    // postgres's POSIX ARE, mongo's PCRE engine). There is NO enforced or
    // edge-case-tested "pinned regex-flavor subset" despite an earlier,
    // inaccurate version of this comment claiming one — see
    // docs/decisions.md's "batch 6 regex-flavor contract" entry (post-batch-6
    // section) for the finding and what's actually proven vs. disclosed-open.
    // `pattern` (and regex_replace's
    // `replacement`, parse_date's `format`) must be literal Expr nodes —
    // compile-time translated/validated, not runtime-dynamic; a non-literal
    // throws a clear compile error rather than silently degrading.
    // canonicalize collapses internal ASCII-whitespace runs to one space
    // and trims both ends, reusing batch 3's ASCII-only whitespace set
    // exactly (does NOT diverge from trim's pin). strip_accents (NFD +
    // combining-mark strip) is non-pushable on every dialect — residual
    // only. parse_date(text, format) takes a small portable format-token
    // vocabulary (YYYY/MM/DD/HH/mm/ss + literal separators), translated to
    // each dialect's native format-string syntax at compile time; output
    // is the same ISO-8601 canonical shape the date-part functions above
    // already consume (composable: year(parse_date(...))). parse_number
    // takes an optional decimalSeparator arg ("." default) and delegates
    // to to_number's existing numeric-regex/overflow machinery after
    // separator normalization — no scientific-notation support (disclosed
    // scope narrowing).
    | "regex_match"
    | "regex_extract"
    | "regex_replace"
    | "canonicalize"
    | "strip_accents"
    | "parse_date"
    | "parse_number";
  args: Expr[];
}
export interface ExprComparison {
  kind: "comparison";
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  left: Expr;
  right: Expr;
}
export interface ExprLogical {
  kind: "logical";
  op: "and" | "or" | "not";
  /** "not" must have exactly 1 element — enforced at parse time and by ExprSchema's superRefine. */
  args: Expr[];
}
export interface ExprConditional {
  kind: "conditional";
  /** At least 1 branch. */
  branches: { when: Expr; then: Expr }[];
  /** Required — no implicit null-else, avoids null-vs-missing ambiguity. */
  else: Expr;
}
export type Expr =
  | ExprFieldRef
  | ExprLiteral
  | ExprBinary
  | ExprCall
  | ExprComparison
  | ExprLogical
  | ExprConditional;

/** "scalar" covers field/literal(non-boolean)/binary/non-predicate-call/conditional-yielding-scalar. */
export type ExprValueType = "scalar" | "boolean";

// `to_boolean` is deliberately NOT a member: every function here is
// guaranteed to NEVER return NULL (they're all yes/no predicates over a
// value that's always present), so a boolean-typed operand can be used
// directly in a logical/conditional-`when` position with no NULL-branch
// ambiguity. `to_boolean` can return NULL (unparseable input) — using it
// directly as a logical operand would need tri-valued-logic semantics
// this grammar's `and`/`or`/`not`/`when` don't model (batch 4 keeps
// `to_boolean` scalar-typed; see ExprCall's doc comment).
const BOOLEAN_CALL_FNS = new Set<ExprCall["fn"]>(["contains", "is_null", "is_not_null", "is_number", "is_text", "looks_numeric"]);

/**
 * Per-call-fn arg-count bounds (Phase 8b-2, batch 1). Generic `call` nodes
 * previously had NO arity enforcement anywhere (only the special-cased
 * if/ifs/switch conditional sugar did, via buildConditional below) — a gap
 * that mattered once batch 1 introduced functions with real, meaningful
 * arities (e.g. `abs` takes exactly 1 argument; `mod`/`power` take exactly
 * 2; `round`/`round_up`/`round_down` take 1 required + 1 optional digits
 * arg; `divide` takes 2 required + 1 optional default-on-zero arg). Kept
 * as ONE data table (same pattern as ops/types.ts's FN_PUSHABILITY) and
 * checked in two places: parseFactor (immediate parse-time rejection for
 * the UI's hand-typed path) and walkWellFormed (defense-in-depth for
 * trees built directly as JSON, e.g. Copilot-proposed ops, which never go
 * through the parser).
 */
const CALL_ARITY: Record<ExprCall["fn"], { min: number; max: number }> = {
  concat: { min: 1, max: Infinity },
  coalesce: { min: 1, max: Infinity },
  contains: { min: 2, max: 3 },
  is_null: { min: 1, max: 1 },
  is_not_null: { min: 1, max: 1 },
  is_number: { min: 1, max: 1 },
  is_text: { min: 1, max: 1 },
  looks_numeric: { min: 1, max: 1 },
  divide: { min: 2, max: 3 },
  round: { min: 1, max: 2 },
  round_up: { min: 1, max: 2 },
  round_down: { min: 1, max: 2 },
  abs: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  round_to_multiple: { min: 2, max: 2 },
  mod: { min: 2, max: 2 },
  power: { min: 2, max: 2 },
  sqrt: { min: 1, max: 1 },
  sign: { min: 1, max: 1 },
  quotient: { min: 2, max: 2 },
  int: { min: 1, max: 1 },
  trunc: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  ln: { min: 1, max: 1 },
  log: { min: 1, max: 2 },
  upper: { min: 1, max: 1 },
  lower: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  left: { min: 2, max: 2 },
  right: { min: 2, max: 2 },
  mid: { min: 3, max: 3 },
  len: { min: 1, max: 1 },
  substitute: { min: 3, max: 3 },
  find: { min: 2, max: 3 },
  rept: { min: 2, max: 2 },
  // split(text, delimiter, index): index is REQUIRED, not optional — this
  // grammar has no array/list value type, so split must always resolve to
  // a single scalar part, never a whole split array (see docs/decisions.md's
  // batch 3 entry, "split's scalar-only contract").
  split: { min: 3, max: 3 },
  to_number: { min: 1, max: 1 },
  to_integer: { min: 1, max: 1 },
  to_text: { min: 1, max: 1 },
  format_number: { min: 2, max: 2 },
  to_boolean: { min: 1, max: 1 },
  to_date: { min: 1, max: 1 },
  year: { min: 1, max: 1 },
  month: { min: 1, max: 1 },
  day: { min: 1, max: 1 },
  hour: { min: 1, max: 1 },
  minute: { min: 1, max: 1 },
  second: { min: 1, max: 1 },
  quarter: { min: 1, max: 1 },
  weekday: { min: 1, max: 1 },
  date_diff: { min: 3, max: 3 },
  date_add: { min: 3, max: 3 },
  // Phase 8b-2, batch 6: Cleaning vocabulary.
  regex_match: { min: 2, max: 3 },
  regex_extract: { min: 2, max: 3 },
  regex_replace: { min: 3, max: 4 },
  canonicalize: { min: 1, max: 1 },
  strip_accents: { min: 1, max: 1 },
  parse_date: { min: 2, max: 2 },
  parse_number: { min: 1, max: 2 },
};

/** Renders a CALL_ARITY bound as a human-readable expected-count phrase, shared by parseFactor's and walkWellFormed's error messages. */
function describeArity(arity: { min: number; max: number }): string {
  if (arity.min === arity.max) return `exactly ${arity.min} argument${arity.min === 1 ? "" : "s"}`;
  if (arity.max === Infinity) return `at least ${arity.min} argument${arity.min === 1 ? "" : "s"}`;
  return `${arity.min}-${arity.max} arguments`;
}

/**
 * Statically classifies any AST node's value type as "scalar" or "boolean"
 * — the grammar's only two value-type buckets. Exported (Phase 8b-2, batch
 * 4) so op/dialect modules can branch SQL emission at compile time for a
 * call-fn whose argument is boolean-typed (e.g. to_text on a boolean-typed
 * expr needs a 'true'/'false' text branch instead of numeric formatting;
 * postgres in particular has no implicit boolean->numeric coercion and
 * errors on boolean arithmetic operators). Previously module-private.
 */
export function typeOfExpr(expr: Expr): ExprValueType {
  switch (expr.kind) {
    case "field":
      return "scalar";
    case "literal":
      return typeof expr.value === "boolean" ? "boolean" : "scalar";
    case "binary":
      return "scalar";
    case "call":
      return BOOLEAN_CALL_FNS.has(expr.fn) ? "boolean" : "scalar";
    case "comparison":
    case "logical":
      return "boolean";
    case "conditional":
      // Consistency across branches/else is enforced by walkWellFormed; once consistent,
      // any branch's `then` type is the conditional's type.
      return typeOfExpr(expr.branches[0]?.then ?? expr.else);
  }
}

interface WellFormedIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Phase 8b-2, batch 6: fn -> arg indices that must be literal string Expr
 * nodes, not runtime-dynamic expressions. These arguments (regex_match/
 * regex_extract/regex_replace's `pattern`, regex_replace's `replacement`,
 * parse_date's `format`) get compile-time translated/validated per-dialect
 * (regex-flavor subset checking, backreference-syntax translation,
 * format-token-to-native-format-string translation) rather than passed
 * through as an ordinary bound parameter — a runtime-dynamic value here
 * isn't expressible as a single compiled SQL/pipeline expression, so this
 * is rejected at parse/validation time (a clear compile error) rather than
 * silently degrading or throwing at query-execution time.
 */
const LITERAL_STRING_ARG_INDEXES: Partial<Record<ExprCall["fn"], number[]>> = {
  regex_match: [1],
  regex_extract: [1],
  regex_replace: [1, 2],
  parse_date: [1],
};

/**
 * Phase 8b-2, batch 6: fn -> arg indices that must be literal NUMBER Expr
 * nodes. Only `regex_extract`'s optional `group` arg needs this: which
 * capture group to select determines the SHAPE of the compiled SQL/mongo
 * expression (a literal array index into the compiled regex-match result),
 * not an ordinary bound runtime value — same "structural, not data"
 * reasoning as the literal-string requirements above, just a different JS
 * type.
 */
const LITERAL_NUMBER_ARG_INDEXES: Partial<Record<ExprCall["fn"], number[]>> = {
  regex_extract: [2],
};

/** Recursive well-formedness walk backing ExprSchema's superRefine (defense-in-depth for non-parser-constructed trees). */
function walkWellFormed(expr: Expr, path: (string | number)[], issues: WellFormedIssue[]): void {
  switch (expr.kind) {
    case "field":
    case "literal":
      return;
    case "binary": {
      if (typeOfExpr(expr.left) === "boolean") issues.push({ path: [...path, "left"], message: "binary operand must not be boolean." });
      if (typeOfExpr(expr.right) === "boolean") issues.push({ path: [...path, "right"], message: "binary operand must not be boolean." });
      walkWellFormed(expr.left, [...path, "left"], issues);
      walkWellFormed(expr.right, [...path, "right"], issues);
      return;
    }
    case "call": {
      const arity = CALL_ARITY[expr.fn];
      if (expr.args.length < arity.min || expr.args.length > arity.max) {
        issues.push({ path: [...path, "args"], message: `${expr.fn}(...) expects ${describeArity(arity)}, got ${expr.args.length}.` });
      }
      const literalStrIdxs = LITERAL_STRING_ARG_INDEXES[expr.fn];
      if (literalStrIdxs) {
        for (const i of literalStrIdxs) {
          const a = expr.args[i];
          if (a !== undefined && !(a.kind === "literal" && typeof a.value === "string")) {
            issues.push({ path: [...path, "args", i], message: `${expr.fn}(...) argument ${i} must be a literal string.` });
          }
        }
      }
      const literalNumIdxs = LITERAL_NUMBER_ARG_INDEXES[expr.fn];
      if (literalNumIdxs) {
        for (const i of literalNumIdxs) {
          const a = expr.args[i];
          if (a !== undefined && !(a.kind === "literal" && typeof a.value === "number")) {
            issues.push({ path: [...path, "args", i], message: `${expr.fn}(...) argument ${i} must be a literal number.` });
          }
        }
      }
      expr.args.forEach((a, i) => walkWellFormed(a, [...path, "args", i], issues));
      return;
    }
    case "comparison": {
      if (typeOfExpr(expr.left) === "boolean") issues.push({ path: [...path, "left"], message: "comparison operand must not be boolean." });
      if (typeOfExpr(expr.right) === "boolean") issues.push({ path: [...path, "right"], message: "comparison operand must not be boolean." });
      walkWellFormed(expr.left, [...path, "left"], issues);
      walkWellFormed(expr.right, [...path, "right"], issues);
      return;
    }
    case "logical": {
      if (expr.op === "not" && expr.args.length !== 1) {
        issues.push({ path: [...path, "args"], message: '"not" must have exactly 1 argument.' });
      }
      expr.args.forEach((a, i) => {
        if (typeOfExpr(a) !== "boolean") issues.push({ path: [...path, "args", i], message: "logical operand must be boolean." });
        walkWellFormed(a, [...path, "args", i], issues);
      });
      return;
    }
    case "conditional": {
      if (expr.branches.length === 0) issues.push({ path: [...path, "branches"], message: "conditional must have at least 1 branch." });
      expr.branches.forEach((b, i) => {
        if (typeOfExpr(b.when) !== "boolean") {
          issues.push({ path: [...path, "branches", i, "when"], message: "conditional branch's when must be boolean." });
        }
        walkWellFormed(b.when, [...path, "branches", i, "when"], issues);
        walkWellFormed(b.then, [...path, "branches", i, "then"], issues);
      });
      walkWellFormed(expr.else, [...path, "else"], issues);
      const yields = [...expr.branches.map((b) => b.then), expr.else];
      const firstType = yields.length > 0 ? typeOfExpr(yields[0]!) : "scalar";
      if (yields.some((y) => typeOfExpr(y) !== firstType)) {
        issues.push({ path, message: "conditional branches and else must all yield the same type (all scalar or all boolean)." });
      }
      return;
    }
  }
}

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("field"), name: z.string().min(1) }),
      z.object({ kind: z.literal("literal"), value: z.union([z.string(), z.number(), z.boolean()]) }),
      z.object({ kind: z.literal("binary"), op: z.enum(["+", "-", "*", "/"]), left: ExprSchema, right: ExprSchema }),
      z.object({
        kind: z.literal("call"),
        fn: z.enum([
          "concat",
          "coalesce",
          "contains",
          "is_null",
          "is_not_null",
          "is_number",
          "is_text",
          "looks_numeric",
          "divide",
          "round",
          "round_up",
          "round_down",
          "abs",
          "ceil",
          "floor",
          "round_to_multiple",
          "mod",
          "power",
          "sqrt",
          "sign",
          "quotient",
          "int",
          "trunc",
          "exp",
          "ln",
          "log",
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
          "to_number",
          "to_integer",
          "to_text",
          "format_number",
          "to_boolean",
          "to_date",
          "year",
          "month",
          "day",
          "hour",
          "minute",
          "second",
          "quarter",
          "weekday",
          "date_diff",
          "date_add",
          // Phase 8b-2, batch 6: Cleaning vocabulary.
          "regex_match",
          "regex_extract",
          "regex_replace",
          "canonicalize",
          "strip_accents",
          "parse_date",
          "parse_number",
        ]),
        args: z.array(ExprSchema),
      }),
      z.object({ kind: z.literal("comparison"), op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]), left: ExprSchema, right: ExprSchema }),
      z.object({ kind: z.literal("logical"), op: z.enum(["and", "or", "not"]), args: z.array(ExprSchema) }),
      z.object({
        kind: z.literal("conditional"),
        branches: z.array(z.object({ when: ExprSchema, then: ExprSchema })).min(1),
        else: ExprSchema,
      }),
    ])
    .superRefine((expr, ctx) => {
      const issues: WellFormedIssue[] = [];
      walkWellFormed(expr, [], issues);
      for (const issue of issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path });
      }
    }),
);

export type ExprParseResult = { ok: true; expr: Expr } | { ok: false; error: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "punct"; value: "+" | "-" | "*" | "/" | "(" | ")" | "," | "[" | "]" | "=" | "!=" | "<" | "<=" | ">" | ">=" };

function tokenize(input: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if ("+-*/(),[]".includes(c)) {
      tokens.push({ kind: "punct", value: c as never });
      i++;
      continue;
    }
    if (c === "!" || c === "<" || c === ">" || c === "=") {
      const two = input.slice(i, i + 2);
      if (two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ kind: "punct", value: two as never });
        i += 2;
        continue;
      }
      if (c === "=" || c === "<" || c === ">") {
        tokens.push({ kind: "punct", value: c as never });
        i++;
        continue;
      }
      return { error: `Unexpected character "${c}" at position ${i}.` };
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < n && input[j] !== quote) {
        value += input[j];
        j++;
      }
      if (j >= n) return { error: `Unterminated string literal starting at position ${i}.` };
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(input[j]!)) j++;
      const raw = input.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) return { error: `Invalid number literal "${raw}" at position ${i}.` };
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.]/.test(input[j]!)) j++;
      tokens.push({ kind: "ident", value: input.slice(i, j) });
      i = j;
      continue;
    }
    return { error: `Unexpected character "${c}" at position ${i}.` };
  }
  return tokens;
}

const CALL_FNS = new Set([
  "concat",
  "coalesce",
  "contains",
  "is_null",
  "is_not_null",
  "is_number",
  "is_text",
  "looks_numeric",
  "divide",
  "round",
  "round_up",
  "round_down",
  "abs",
  "ceil",
  "floor",
  "round_to_multiple",
  "mod",
  "power",
  "sqrt",
  "sign",
  "quotient",
  "int",
  "trunc",
  "exp",
  "ln",
  "log",
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
  "to_number",
  "to_integer",
  "to_text",
  "format_number",
  "to_boolean",
  "to_date",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "quarter",
  "weekday",
  "date_diff",
  "date_add",
  // Phase 8b-2, batch 6: Cleaning vocabulary.
  "regex_match",
  "regex_extract",
  "regex_replace",
  "canonicalize",
  "strip_accents",
  "parse_date",
  "parse_number",
]);
const CONDITIONAL_FNS = new Set(["if", "ifs", "switch"] as const);
type ConditionalFn = "if" | "ifs" | "switch";

/** Desugars if/ifs/switch's flat arg list into the one n-ary `conditional` node (see module doc). */
function buildConditional(fnName: ConditionalFn, args: Expr[]): Expr | { error: string } {
  if (fnName === "if") {
    if (args.length !== 3) return { error: `if(...) expects 3 arguments (condition, then, else), got ${args.length}.` };
    return { kind: "conditional", branches: [{ when: args[0]!, then: args[1]! }], else: args[2]! };
  }
  if (fnName === "ifs") {
    if (args.length < 3 || args.length % 2 === 0) {
      return { error: `ifs(...) expects an odd number of arguments >= 3 (condition/then pairs, then a final else), got ${args.length}.` };
    }
    const branches: { when: Expr; then: Expr }[] = [];
    for (let i = 0; i < args.length - 1; i += 2) {
      branches.push({ when: args[i]!, then: args[i + 1]! });
    }
    return { kind: "conditional", branches, else: args[args.length - 1]! };
  }
  // switch
  if (args.length < 4 || args.length % 2 !== 0) {
    return { error: `switch(...) expects an even number of arguments >= 4 (target, value/result pairs, then a final else), got ${args.length}.` };
  }
  const target = args[0]!;
  const branches: { when: Expr; then: Expr }[] = [];
  for (let i = 1; i < args.length - 1; i += 2) {
    branches.push({ when: { kind: "comparison", op: "eq", left: target, right: args[i]! }, then: args[i + 1]! });
  }
  return { kind: "conditional", branches, else: args[args.length - 1]! };
}

/**
 * Hand-rolled recursive-descent parser over the tokenized input — small
 * enough that a parser generator would be overkill, same "hand-rolled,
 * not a real grammar engine" tradeoff as guardrails/sql's tokenizer.
 * Returns a parse error (not a thrown exception) so the UI can show it
 * inline without a try/catch at every call site.
 */
export function parseExpression(input: string): ExprParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Expression is empty." };

  const tokenResult = tokenize(trimmed);
  if ("error" in tokenResult) return { ok: false, error: tokenResult.error };
  const tokens = tokenResult;
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }
  function next(): Token | undefined {
    return tokens[pos++];
  }

  function parseOr(): Expr | { error: string } {
    let left = parseAnd();
    if ("error" in left) return left;
    for (;;) {
      const t = peek();
      if (t?.kind === "ident" && t.value === "or") {
        next();
        const right = parseAnd();
        if ("error" in right) return right;
        left = { kind: "logical", op: "or", args: [left, right] };
        continue;
      }
      break;
    }
    return left;
  }

  function parseAnd(): Expr | { error: string } {
    let left = parseNot();
    if ("error" in left) return left;
    for (;;) {
      const t = peek();
      if (t?.kind === "ident" && t.value === "and") {
        next();
        const right = parseNot();
        if ("error" in right) return right;
        left = { kind: "logical", op: "and", args: [left, right] };
        continue;
      }
      break;
    }
    return left;
  }

  function parseNot(): Expr | { error: string } {
    const t = peek();
    if (t?.kind === "ident" && t.value === "not") {
      next();
      const operand = parseNot();
      if ("error" in operand) return operand;
      return { kind: "logical", op: "not", args: [operand] };
    }
    return parseComparison();
  }

  const COMPARISON_OPS: Record<string, ExprComparison["op"]> = {
    "=": "eq",
    "!=": "neq",
    "<": "lt",
    "<=": "lte",
    ">": "gt",
    ">=": "gte",
  };

  function parseComparison(): Expr | { error: string } {
    const left = parseArith();
    if ("error" in left) return left;
    const t = peek();
    if (t?.kind === "punct" && t.value in COMPARISON_OPS) {
      next();
      const right = parseArith();
      if ("error" in right) return right;
      return { kind: "comparison", op: COMPARISON_OPS[t.value]!, left, right };
    }
    return left;
  }

  function parseArith(): Expr | { error: string } {
    let left = parseTerm();
    if ("error" in left) return left;
    for (;;) {
      const t = peek();
      if (t?.kind === "punct" && (t.value === "+" || t.value === "-")) {
        next();
        const right = parseTerm();
        if ("error" in right) return right;
        left = { kind: "binary", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  function parseTerm(): Expr | { error: string } {
    let left = parseUnary();
    if ("error" in left) return left;
    for (;;) {
      const t = peek();
      if (t?.kind === "punct" && (t.value === "*" || t.value === "/")) {
        next();
        const right = parseUnary();
        if ("error" in right) return right;
        left = { kind: "binary", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  /** Unary minus (Phase 8b-2b). Folds into a single negative literal when the
   * operand is one (e.g. `-1` -> literal -1, avoiding the Postgres untyped-
   * bind-param-arithmetic issue for the common case); otherwise desugars to
   * `0 - operand`, reusing the existing binary AST node so no new node kind
   * (and no new walker cases) is needed. */
  function parseUnary(): Expr | { error: string } {
    const t = peek();
    if (t?.kind === "punct" && t.value === "-") {
      next();
      const operand = parseUnary();
      if ("error" in operand) return operand;
      if (operand.kind === "literal" && typeof operand.value === "number") {
        return { kind: "literal", value: -operand.value };
      }
      return { kind: "binary", op: "-", left: { kind: "literal", value: 0 }, right: operand };
    }
    return parseFactor();
  }

  function parseFactor(): Expr | { error: string } {
    const t = next();
    if (!t) return { error: "Unexpected end of expression." };

    if (t.kind === "number") return { kind: "literal", value: t.value };
    if (t.kind === "string") return { kind: "literal", value: t.value };

    if (t.kind === "punct" && t.value === "(") {
      const inner = parseOr();
      if ("error" in inner) return inner;
      const close = next();
      if (!close || close.kind !== "punct" || close.value !== ")") return { error: 'Expected ")".' };
      return inner;
    }

    if (t.kind === "punct" && t.value === "[") {
      const nameTok = next();
      if (!nameTok || nameTok.kind !== "string") return { error: 'Expected a quoted field name after "[".' };
      const close = next();
      if (!close || close.kind !== "punct" || close.value !== "]") return { error: 'Expected "]".' };
      return { kind: "field", name: nameTok.value };
    }

    if (t.kind === "ident") {
      if (t.value === "true") return { kind: "literal", value: true };
      if (t.value === "false") return { kind: "literal", value: false };

      const isCallLike = (CALL_FNS.has(t.value) || CONDITIONAL_FNS.has(t.value as ConditionalFn)) && peek()?.kind === "punct" && peek()!.value === "(";
      if (isCallLike) {
        next(); // consume "("
        const args: Expr[] = [];
        if (!(peek()?.kind === "punct" && peek()!.value === ")")) {
          for (;;) {
            const arg = parseOr();
            if ("error" in arg) return arg;
            args.push(arg);
            const sep = peek();
            if (sep?.kind === "punct" && sep.value === ",") {
              next();
              continue;
            }
            break;
          }
        }
        const close = next();
        if (!close || close.kind !== "punct" || close.value !== ")") return { error: 'Expected ")".' };

        if (CONDITIONAL_FNS.has(t.value as ConditionalFn)) {
          return buildConditional(t.value as ConditionalFn, args);
        }
        const arity = CALL_ARITY[t.value as ExprCall["fn"]];
        if (args.length < arity.min || args.length > arity.max) {
          return { error: `${t.value}(...) expects ${describeArity(arity)}, got ${args.length}.` };
        }
        return { kind: "call", fn: t.value as ExprCall["fn"], args };
      }
      return { kind: "field", name: t.value };
    }

    return { error: `Unexpected token "${JSON.stringify(t)}".` };
  }

  const result = parseOr();
  if ("error" in result) return { ok: false, error: result.error };
  if (pos < tokens.length) {
    return { ok: false, error: `Unexpected trailing input at token ${pos}.` };
  }
  return { ok: true, expr: result };
}

/** Inverse of parseExpression — renders an AST back to editable source text (round-trips through the editor). */
export function stringifyExpression(expr: Expr): string {
  switch (expr.kind) {
    case "field":
      return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(expr.name) ? expr.name : `["${expr.name}"]`;
    case "literal":
      return typeof expr.value === "string" ? `"${expr.value}"` : String(expr.value);
    case "binary":
      return `(${stringifyExpression(expr.left)} ${expr.op} ${stringifyExpression(expr.right)})`;
    case "call":
      return `${expr.fn}(${expr.args.map(stringifyExpression).join(", ")})`;
    case "comparison": {
      const opText = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[expr.op];
      return `(${stringifyExpression(expr.left)} ${opText} ${stringifyExpression(expr.right)})`;
    }
    case "logical":
      if (expr.op === "not") return `(not ${stringifyExpression(expr.args[0]!)})`;
      return `(${expr.args.map(stringifyExpression).join(` ${expr.op} `)})`;
    case "conditional": {
      // Always round-trips through the n-ary "ifs" surface form (switch is sugar that desugars away at parse time — expected, not a bug).
      const parts = expr.branches.flatMap((b) => [stringifyExpression(b.when), stringifyExpression(b.then)]);
      return `ifs(${[...parts, stringifyExpression(expr.else)].join(", ")})`;
    }
  }
}

/** The call-fn name union, exported under its own name (Phase 8b-2, batch 0) so ops/types.ts's FN_PUSHABILITY table and collectCallFns below don't need to reach into ExprCall's shape directly. */
export type CallFn = ExprCall["fn"];

/** Collects every call-fn name used anywhere in an expression tree (recursing into every node kind, mirroring collectFieldRefs) — backs ops/types.ts's exprFnsPushable, which checks each one against FN_PUSHABILITY for a given dialect. */
export function collectCallFns(expr: Expr): Set<CallFn> {
  const fns = new Set<CallFn>();
  function walk(node: Expr): void {
    switch (node.kind) {
      case "field":
      case "literal":
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "call":
        fns.add(node.fn);
        node.args.forEach(walk);
        return;
      case "comparison":
        walk(node.left);
        walk(node.right);
        return;
      case "logical":
        node.args.forEach(walk);
        return;
      case "conditional":
        node.branches.forEach((b) => {
          walk(b.when);
          walk(b.then);
        });
        walk(node.else);
        return;
    }
  }
  walk(expr);
  return fns;
}

/**
 * Phase 8b-3 — the fallible-call vocabulary: every call-fn that can return
 * NULL on a row where all its own arguments are non-null (a "failure", per
 * onFailure's contract — NULL *input* is never a failure, only an
 * unparseable/out-of-range non-null input is). Deliberately excludes
 * `to_text` (never nulls on non-null input) and `format_number` (can null
 * on a non-null-but-invalid `decimals` arg, but out of scope by decision —
 * see docs/decisions.md's 8b-3 entry). Other candidates (regex no-match,
 * divide by zero) are deferred — see TODO.md.
 */
export const FALLIBLE_CALL_FNS: ReadonlySet<CallFn> = new Set([
  "to_number",
  "to_integer",
  "to_boolean",
  "to_date",
  "parse_date",
  "parse_number",
]);

/**
 * Phase 8b-3 follow-up — a fallible call directly wrapped by `coalesce`,
 * `is_null`, or `is_not_null` is considered explicitly handled by the
 * author (the expression already branches on/defaults the null result), so
 * it's excluded from the failure predicate. Only DIRECT nesting counts —
 * `is_null(x + to_number(y))` does NOT count (the binary breaks direct
 * adjacency), but `is_null(to_number(x))` and `coalesce(to_number(x), 0)`
 * do. This matches the Phase 13 missing-value specialist's expected
 * `coalesce(to_number(x), default)` output shape.
 *
 * Phase 9 follow-up (numeric group-key pagination session) — this
 * "coalesce always handles" rule was too broad: `coalesce(parse_date(x,
 * f1), parse_date(x, f2))` marked BOTH calls handled, so a value matching
 * neither format silently became NULL with no failure ever counted. Fixed
 * below: a `coalesce` only handles its nested fallible calls when its LAST
 * argument is itself non-fallible (a literal, a column, or an expression
 * containing no fallible calls anywhere — see `collectFallibleCallsDeep`)
 * — i.e. it has a guaranteed non-null fallback. When the last argument is
 * itself fallible, the coalesce as a whole is treated as ONE compound
 * fallible unit instead (see `collectFallibleCalls`'s `coalesce` branch and
 * `buildFailureExpr`'s matching branch): it fails when every nested
 * fallible call's own inputs were non-null (each one genuinely ran, not
 * skipped on a null input) AND the coalesce's overall result is still
 * NULL (every argument, fallible or not, resolved to null). `is_null` /
 * `is_not_null` keep their original, unconditional direct-nesting
 * exemption — unaffected by this change.
 */
const FAILURE_HANDLING_FNS: ReadonlySet<CallFn> = new Set(["coalesce", "is_null", "is_not_null"]);

/** Structural, exemption-ignoring deep collector: every call node anywhere in `expr` whose fn is in FALLIBLE_CALL_FNS, regardless of any coalesce/is_null/is_not_null wrapping. Used only (a) to decide whether a coalesce's last argument is itself capable of producing a fallible null, and (b) to gather the inner calls for that coalesce's compound failure predicate — see collectFallibleCalls's `coalesce` branch. Not a general-purpose substitute for collectFallibleCalls, which is exemption-aware. */
function collectFallibleCallsDeep(expr: Expr): ExprCall[] {
  const calls: ExprCall[] = [];
  function walk(node: Expr): void {
    switch (node.kind) {
      case "field":
      case "literal":
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "call":
        if (FALLIBLE_CALL_FNS.has(node.fn)) calls.push(node);
        node.args.forEach(walk);
        return;
      case "comparison":
        walk(node.left);
        walk(node.right);
        return;
      case "logical":
        node.args.forEach(walk);
        return;
      case "conditional":
        node.branches.forEach((b) => {
          walk(b.when);
          walk(b.then);
        });
        walk(node.else);
        return;
    }
  }
  walk(expr);
  return calls;
}

/** Collects every fallible call node (not just fn names — callers need `.args` to build a failure predicate) anywhere in an expression tree, mirroring collectCallFns's recursion shape. Excludes fallible calls directly wrapped by a handling fn (see FAILURE_HANDLING_FNS) — except a `coalesce` whose last argument is itself fallible, which is returned as a single compound unit (the `coalesce` call node itself) instead of its individual nested calls; see this file's `coalesce` doc comment above and `buildFailureExpr`'s matching branch. */
export function collectFallibleCalls(expr: Expr): ExprCall[] {
  const calls: ExprCall[] = [];
  function walk(node: Expr, parentFn: CallFn | null): void {
    switch (node.kind) {
      case "field":
      case "literal":
        return;
      case "binary":
        walk(node.left, null);
        walk(node.right, null);
        return;
      case "call":
        if (node.fn === "coalesce") {
          const last = node.args[node.args.length - 1];
          const lastIsFallible = last !== undefined && collectFallibleCallsDeep(last).length > 0;
          if (lastIsFallible) {
            // No guaranteed non-null fallback — the coalesce itself is
            // fallible. Recorded as one compound unit; its nested calls'
            // fallibility is fully captured by that unit, so they are
            // deliberately NOT also walked/collected individually here.
            calls.push(node);
            return;
          }
          // Last argument is safe: original "coalesce always handles"
          // behavior for its directly-nested fallible calls.
          node.args.forEach((arg) => walk(arg, node.fn));
          return;
        }
        if (FALLIBLE_CALL_FNS.has(node.fn) && !(parentFn !== null && FAILURE_HANDLING_FNS.has(parentFn))) {
          calls.push(node);
        }
        node.args.forEach((arg) => walk(arg, node.fn));
        return;
      case "comparison":
        walk(node.left, null);
        walk(node.right, null);
        return;
      case "logical":
        node.args.forEach((arg) => walk(arg, null));
        return;
      case "conditional":
        node.branches.forEach((b) => {
          walk(b.when, null);
          walk(b.then, null);
        });
        walk(node.else, null);
        return;
    }
  }
  walk(expr, null);
  return calls;
}

/**
 * Builds a synthetic boolean Expr that evaluates true on a row exactly when
 * `expr` contains a fallible call that FAILED on that row (per
 * FALLIBLE_CALL_FNS's doc comment: all of that call's own arguments
 * non-null, but its own result null). Built entirely out of grammar that's
 * already pushable everywhere its inputs are (`is_null`/`is_not_null` are
 * unconditionally pushable on every dialect — ops/types.ts's
 * FN_PUSHABILITY), so this expression can be compiled through the exact
 * same `compileExpr`/`compileCondition`/having-substitution path as the
 * original expression — no new dialect plumbing needed. Multiple fallible
 * calls in one expression OR together (the row failed if *any* of them
 * did). Returns null when `expr` has no fallible calls (nothing to build).
 */
export function buildFailureExpr(expr: Expr): Expr | null {
  const calls = collectFallibleCalls(expr);
  if (calls.length === 0) return null;
  const perCall: Expr[] = calls.map((call) => {
    if (call.fn === "coalesce") {
      // Compound unit (see collectFallibleCalls's `coalesce` branch): using
      // the generic branch below (call.args.map(is_not_null)) would be
      // wrong here — `call.args` ARE the fallible sub-calls, so requiring
      // them "non-null" would directly contradict `is_null(call)` and this
      // branch would never fire. Instead: every fallible call nested
      // anywhere inside this coalesce must have run on a non-null input,
      // AND the coalesce as a whole must still be NULL.
      const inner = collectFallibleCallsDeep(call);
      const argsNonNull: Expr[] = inner.flatMap((c) => c.args.map((arg): Expr => ({ kind: "call", fn: "is_not_null", args: [arg] })));
      const resultIsNull: Expr = { kind: "call", fn: "is_null", args: [call] };
      return argsNonNull.length > 0 ? { kind: "logical", op: "and", args: [resultIsNull, ...argsNonNull] } : resultIsNull;
    }
    const argsNonNull: Expr[] = call.args.map((arg) => ({ kind: "call", fn: "is_not_null", args: [arg] }));
    const resultIsNull: Expr = { kind: "call", fn: "is_null", args: [call] };
    return argsNonNull.length > 0
      ? { kind: "logical", op: "and", args: [resultIsNull, ...argsNonNull] }
      : resultIsNull;
  });
  return perCall.length === 1 ? perCall[0]! : { kind: "logical", op: "or", args: perCall };
}

/** Collects every field reference in an expression tree — used to validate computed fields only reference upstream columns and by the pushdown compiler's dependency analysis. */
export function collectFieldRefs(expr: Expr): string[] {
  switch (expr.kind) {
    case "field":
      return [expr.name];
    case "literal":
      return [];
    case "binary":
      return [...collectFieldRefs(expr.left), ...collectFieldRefs(expr.right)];
    case "call":
      return expr.args.flatMap(collectFieldRefs);
    case "comparison":
      return [...collectFieldRefs(expr.left), ...collectFieldRefs(expr.right)];
    case "logical":
      return expr.args.flatMap(collectFieldRefs);
    case "conditional":
      return [...expr.branches.flatMap((b) => [...collectFieldRefs(b.when), ...collectFieldRefs(b.then)]), ...collectFieldRefs(expr.else)];
  }
}
