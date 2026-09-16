import { z } from "zod";

/**
 * Restricted expression grammar for a transform node's "computed field"
 * step (nodeConfig.ts's ComputedFieldStep). Parsed once, in the canvas UI,
 * into this AST — never stored as a raw string in GraphDoc — so the
 * pushdown compiler (pushdown.ts, same package so both apps/worker and
 * apps/web can import it) can walk a known shape instead of re-parsing/
 * trusting user text at compile time.
 *
 * Grammar (intentionally small — anything outside this is a parse error,
 * surfaced as an inline UI error rather than silently saved):
 *   expr       := term (("+" | "-") term)*
 *   term       := factor (("*" | "/") factor)*
 *   factor     := NUMBER | STRING | fieldRef | call | "(" expr ")"
 *   fieldRef   := IDENT | "[" STRING "]"        (bracket form for names with spaces/symbols)
 *   call       := ("concat" | "coalesce") "(" expr ("," expr)* ")"
 */

export interface ExprFieldRef {
  kind: "field";
  name: string;
}
export interface ExprLiteral {
  kind: "literal";
  value: string | number;
}
export interface ExprBinary {
  kind: "binary";
  op: "+" | "-" | "*" | "/";
  left: Expr;
  right: Expr;
}
export interface ExprCall {
  kind: "call";
  fn: "concat" | "coalesce";
  args: Expr[];
}
export type Expr = ExprFieldRef | ExprLiteral | ExprBinary | ExprCall;

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("field"), name: z.string().min(1) }),
    z.object({ kind: z.literal("literal"), value: z.union([z.string(), z.number()]) }),
    z.object({ kind: z.literal("binary"), op: z.enum(["+", "-", "*", "/"]), left: ExprSchema, right: ExprSchema }),
    z.object({ kind: z.literal("call"), fn: z.enum(["concat", "coalesce"]), args: z.array(ExprSchema) }),
  ]),
);

export type ExprParseResult = { ok: true; expr: Expr } | { ok: false; error: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "punct"; value: "+" | "-" | "*" | "/" | "(" | ")" | "," | "[" | "]" };

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

const CALL_FNS = new Set(["concat", "coalesce"]);

/**
 * Hand-rolled recursive-descent parser over the tokenized input — small
 * enough (4 grammar rules) that a parser generator would be overkill, same
 * "hand-rolled, not a real grammar engine" tradeoff as guardrails/sql's
 * tokenizer. Returns a parse error (not a thrown exception) so the UI can
 * show it inline without a try/catch at every call site.
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

  function parseExpr(): Expr | { error: string } {
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
      const inner = parseExpr();
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
      if (CALL_FNS.has(t.value) && peek()?.kind === "punct" && peek()!.value === "(") {
        next(); // consume "("
        const args: Expr[] = [];
        if (!(peek()?.kind === "punct" && peek()!.value === ")")) {
          for (;;) {
            const arg = parseExpr();
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
        return { kind: "call", fn: t.value as "concat" | "coalesce", args };
      }
      return { kind: "field", name: t.value };
    }

    return { error: `Unexpected token "${JSON.stringify(t)}".` };
  }

  const result = parseExpr();
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
  }
}
