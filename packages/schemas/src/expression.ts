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
 *   term       := factor (("*" | "/") factor)*
 *   factor     := NUMBER | STRING | "true" | "false" | fieldRef | call
 *               | "if(" or "," or "," or ")"
 *               | "ifs(" or "," or ("," or "," or)* "," or ")"
 *               | "switch(" or ("," or "," or)+ "," or ")"
 *               | "(" or ")"
 *   fieldRef   := IDENT | "[" STRING "]"        (bracket form for names with spaces/symbols)
 *   call       := ("concat"|"coalesce"|"contains"|"is_null"|"is_not_null"|"is_number"|"is_text")
 *                 "(" or ("," or)* ")"
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
  fn: "concat" | "coalesce" | "contains" | "is_null" | "is_not_null" | "is_number" | "is_text";
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
type ExprValueType = "scalar" | "boolean";

const BOOLEAN_CALL_FNS = new Set<ExprCall["fn"]>(["contains", "is_null", "is_not_null", "is_number", "is_text"]);

function typeOfExpr(expr: Expr): ExprValueType {
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
        fn: z.enum(["concat", "coalesce", "contains", "is_null", "is_not_null", "is_number", "is_text"]),
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

const CALL_FNS = new Set(["concat", "coalesce", "contains", "is_null", "is_not_null", "is_number", "is_text"]);
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
    let left = parseFactor();
    if ("error" in left) return left;
    for (;;) {
      const t = peek();
      if (t?.kind === "punct" && (t.value === "*" || t.value === "/")) {
        next();
        const right = parseFactor();
        if ("error" in right) return right;
        left = { kind: "binary", op: t.value, left, right };
        continue;
      }
      break;
    }
    return left;
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
