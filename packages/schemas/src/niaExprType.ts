import type { CallFn, Expr, ExprCall } from "./expression.js";
import { join, type NiaSchema, type NiaType } from "./niaType.js";

/**
 * Schema layer, Part 3 — typeOfExpr: the NiaType an Expr node (expression.ts)
 * produces when evaluated against a given input NiaSchema. See
 * docs/plans/schema-layer.md for the full design.
 *
 * Not to be confused with expression.ts's OWN `typeOfExpr`, which answers a
 * narrower, unrelated question ("scalar" vs "boolean", for the grammar's
 * own well-formedness/three-valued-logic checks) — that function predates
 * this one and must not be touched; this module's `typeOfExpr` lives in a
 * separate file specifically so the two same-named-but-different-purpose
 * functions never collide (see docs/plans/schema-layer.md's Part 3 plan
 * update for the full rationale).
 *
 * Deliberately fails (never guesses) whenever a node's type genuinely can't
 * be determined — an unknown field reference, a bare null literal with no
 * sibling to join against — matching the plan's "name the column, don't
 * guess" requirement.
 */
export type ExprTypeResult = { ok: true; type: NiaType } | { ok: false; error: string };

function isNullLiteral(e: Expr): boolean {
  return e.kind === "literal" && e.value === null;
}

/**
 * Per-call-function NiaType, for every CallFn except `coalesce` (which is
 * special-cased in typeOfCall below, since its result type depends on its
 * arguments' types, not a fixed return type). `Record<Exclude<CallFn,
 * "coalesce">, NiaType>` mirrors ops/types.ts's FN_PUSHABILITY table style —
 * TypeScript enforces that every CallFn (bar coalesce) has an entry here, so
 * a new call-fn added to expression.ts's ExprCall union is a compile error
 * here until classified.
 */
const CALL_FN_TYPE: Record<Exclude<CallFn, "coalesce">, NiaType> = {
  // Boolean-valued predicates (9) — includes regex_match and to_boolean,
  // which are boolean-*typed* even though expression.ts's own
  // BOOLEAN_CALL_FNS set excludes them for an unrelated reason (that set
  // only tracks "never returns NULL", not NiaType).
  contains: { kind: "boolean" },
  is_null: { kind: "boolean" },
  is_not_null: { kind: "boolean" },
  is_number: { kind: "boolean" },
  is_text: { kind: "boolean" },
  looks_numeric: { kind: "boolean" },
  is_missing_token: { kind: "boolean" },
  regex_match: { kind: "boolean" },
  to_boolean: { kind: "boolean" },

  // Integer-valued (12).
  len: { kind: "integer" },
  find: { kind: "integer" },
  year: { kind: "integer" },
  month: { kind: "integer" },
  day: { kind: "integer" },
  hour: { kind: "integer" },
  minute: { kind: "integer" },
  second: { kind: "integer" },
  quarter: { kind: "integer" },
  weekday: { kind: "integer" },
  date_diff: { kind: "integer" },
  to_integer: { kind: "integer" },

  // Float-valued (20) — the Math core/remainder vocabulary, plus the
  // numeric-coercion functions (to_number/parse_number can yield
  // fractional results even for integer-looking text, so both are
  // float, not integer).
  divide: { kind: "float" },
  round: { kind: "float" },
  round_up: { kind: "float" },
  round_down: { kind: "float" },
  abs: { kind: "float" },
  ceil: { kind: "float" },
  floor: { kind: "float" },
  round_to_multiple: { kind: "float" },
  mod: { kind: "float" },
  power: { kind: "float" },
  sqrt: { kind: "float" },
  sign: { kind: "float" },
  quotient: { kind: "float" },
  int: { kind: "float" },
  trunc: { kind: "float" },
  exp: { kind: "float" },
  ln: { kind: "float" },
  log: { kind: "float" },
  to_number: { kind: "float" },
  parse_number: { kind: "float" },

  // String-valued (16) — Text core, plus the cleaning vocabulary's
  // string-returning members, plus to_text/format_number/concat/
  // regex_extract/regex_replace.
  upper: { kind: "string" },
  lower: { kind: "string" },
  trim: { kind: "string" },
  left: { kind: "string" },
  right: { kind: "string" },
  mid: { kind: "string" },
  substitute: { kind: "string" },
  rept: { kind: "string" },
  split: { kind: "string" },
  canonicalize: { kind: "string" },
  strip_accents: { kind: "string" },
  to_text: { kind: "string" },
  format_number: { kind: "string" },
  concat: { kind: "string" },
  regex_extract: { kind: "string" },
  regex_replace: { kind: "string" },

  // Date-valued (3).
  to_date: { kind: "date" },
  parse_date: { kind: "date" },
  date_add: { kind: "date" },

  // Timestamp-valued (1) — internal-only, see expression.ts's `to_timestamp` doc comment.
  to_timestamp: { kind: "timestamp", tz: "utc" },
};

function typeOfCall(expr: ExprCall, input: NiaSchema): ExprTypeResult {
  if (expr.fn === "coalesce") {
    const candidates: NiaType[] = [];
    for (const arg of expr.args) {
      if (isNullLiteral(arg)) continue;
      const t = typeOfExpr(arg, input);
      if (!t.ok) return t;
      candidates.push(t.type);
    }
    if (candidates.length === 0) {
      return { ok: false, error: "coalesce(...) has no argument with a determinable type (every argument is a null literal)." };
    }
    return { ok: true, type: candidates.reduce((acc, t) => join(acc, t).type) };
  }
  // Every other call fn has a fixed return type (CALL_FN_TYPE[expr.fn]),
  // independent of its arguments' types — but its arguments still need to
  // be valid expressions against `input`. Without this, a typo'd/missing
  // field reference nested inside a call's arguments (e.g.
  // to_number(missing_col)) would silently pass validation, contradicting
  // the "never guess" rule this module otherwise enforces uniformly.
  // typeOfExpr recurses through nested calls/binary/conditional on its own,
  // so a single pass over `expr.args` here is sufficient depth.
  for (const arg of expr.args) {
    const t = typeOfExpr(arg, input);
    if (!t.ok) return t;
  }
  return { ok: true, type: CALL_FN_TYPE[expr.fn] };
}

/**
 * The NiaType `expr` produces when evaluated against `input`'s field
 * shapes. Fails (rather than guessing) on an unknown field reference or a
 * conditional/coalesce where every candidate branch is a null literal —
 * both cases where "the type" genuinely isn't determinable from the
 * expression alone.
 */
export function typeOfExpr(expr: Expr, input: NiaSchema): ExprTypeResult {
  switch (expr.kind) {
    case "field": {
      const field = input.fields[expr.name];
      if (!field) return { ok: false, error: `references unknown field "${expr.name}".` };
      return { ok: true, type: field.type };
    }
    case "literal": {
      if (expr.value === null) return { ok: false, error: "a null literal alone has no determinable type." };
      if (typeof expr.value === "boolean") return { ok: true, type: { kind: "boolean" } };
      if (typeof expr.value === "number") return { ok: true, type: Number.isInteger(expr.value) ? { kind: "integer" } : { kind: "float" } };
      return { ok: true, type: { kind: "string" } };
    }
    case "binary": {
      const left = typeOfExpr(expr.left, input);
      if (!left.ok) return left;
      const right = typeOfExpr(expr.right, input);
      if (!right.ok) return right;
      return { ok: true, type: join(left.type, right.type).type };
    }
    case "comparison":
    case "logical":
      return { ok: true, type: { kind: "boolean" } };
    case "call":
      return typeOfCall(expr, input);
    case "conditional": {
      const candidates: NiaType[] = [];
      for (const branch of expr.branches) {
        if (isNullLiteral(branch.then)) continue;
        const t = typeOfExpr(branch.then, input);
        if (!t.ok) return t;
        candidates.push(t.type);
      }
      if (!isNullLiteral(expr.else)) {
        const t = typeOfExpr(expr.else, input);
        if (!t.ok) return t;
        candidates.push(t.type);
      }
      if (candidates.length === 0) {
        return { ok: false, error: "every branch of this conditional is a null literal; cannot determine a type." };
      }
      return { ok: true, type: candidates.reduce((acc, t) => join(acc, t).type) };
    }
  }
}
