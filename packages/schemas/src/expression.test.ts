import { describe, it, expect } from "vitest";
import { parseExpression, stringifyExpression, collectFieldRefs, ExprSchema } from "./expression.js";

describe("parseExpression", () => {
  it("parses a bare field reference", () => {
    const result = parseExpression("total_amount");
    expect(result).toEqual({ ok: true, expr: { kind: "field", name: "total_amount" } });
  });

  it("parses a bracketed field name with spaces", () => {
    const result = parseExpression('["order total"]');
    expect(result).toEqual({ ok: true, expr: { kind: "field", name: "order total" } });
  });

  it("parses number and string literals", () => {
    expect(parseExpression("42")).toEqual({ ok: true, expr: { kind: "literal", value: 42 } });
    expect(parseExpression('"usd"')).toEqual({ ok: true, expr: { kind: "literal", value: "usd" } });
  });

  it("parses the null keyword as a null literal", () => {
    expect(parseExpression("null")).toEqual({ ok: true, expr: { kind: "literal", value: null } });
  });

  it("parses binary arithmetic with left-to-right precedence (+/- lower than */)", () => {
    const result = parseExpression("price * qty + tax");
    expect(result).toEqual({
      ok: true,
      expr: {
        kind: "binary",
        op: "+",
        left: { kind: "binary", op: "*", left: { kind: "field", name: "price" }, right: { kind: "field", name: "qty" } },
        right: { kind: "field", name: "tax" },
      },
    });
  });

  it("respects parentheses", () => {
    const result = parseExpression("(price + tax) * qty");
    expect(result).toEqual({
      ok: true,
      expr: {
        kind: "binary",
        op: "*",
        left: { kind: "binary", op: "+", left: { kind: "field", name: "price" }, right: { kind: "field", name: "tax" } },
        right: { kind: "field", name: "qty" },
      },
    });
  });

  it("parses concat() and coalesce() calls with nested args", () => {
    const result = parseExpression('concat(first_name, " ", coalesce(last_name, "?"))');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expr).toEqual({
        kind: "call",
        fn: "concat",
        args: [
          { kind: "field", name: "first_name" },
          { kind: "literal", value: " " },
          { kind: "call", fn: "coalesce", args: [{ kind: "field", name: "last_name" }, { kind: "literal", value: "?" }] },
        ],
      });
    }
  });

  it("rejects an empty expression", () => {
    expect(parseExpression("").ok).toBe(false);
    expect(parseExpression("   ").ok).toBe(false);
  });

  it("rejects a call to a function outside the grammar", () => {
    // Phase 8b-2, batch 3: "upper" used to be this test's canonical
    // out-of-grammar example, but it's now a real CALL_FNS member (Text
    // core) — swapped to "shout", which remains outside the grammar.
    const result = parseExpression("shout(name)");
    // "shout" isn't in CALL_FNS, so it's parsed as a bare field ref, then the
    // leftover "(name)" is unparsed trailing input -> a parse error.
    expect(result.ok).toBe(false);
  });

  it("rejects unbalanced parentheses", () => {
    expect(parseExpression("(price + tax").ok).toBe(false);
  });

  it("rejects a disallowed operator character", () => {
    expect(parseExpression("price % qty").ok).toBe(false);
  });

  it("rejects an unterminated string literal", () => {
    expect(parseExpression('"unterminated').ok).toBe(false);
  });

  it("round-trips through stringifyExpression + re-parse", () => {
    const original = "price * qty + tax";
    const parsed = parseExpression(original);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = stringifyExpression(parsed.expr);
    const reparsed = parseExpression(text);
    expect(reparsed).toEqual({ ok: true, expr: parsed.expr });
  });

  it("round-trips a null literal nested in a conditional's then-branch (the missing-value specialist's output shape)", () => {
    const expr = {
      kind: "conditional" as const,
      branches: [
        {
          when: { kind: "comparison" as const, op: "eq" as const, left: { kind: "field" as const, name: "notes" }, right: { kind: "literal" as const, value: "n/a" } },
          then: { kind: "literal" as const, value: null },
        },
      ],
      else: { kind: "field" as const, name: "notes" },
    };
    const text = stringifyExpression(expr);
    expect(text).toContain("null");
    const reparsed = parseExpression(text);
    expect(reparsed).toEqual({ ok: true, expr });
  });

  it("ExprSchema rejects a null literal used directly as a comparison operand, pointing at is_null/is_not_null", () => {
    const parsed = ExprSchema.safeParse({ kind: "comparison", op: "eq", left: { kind: "field", name: "notes" }, right: { kind: "literal", value: null } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("is_null()/is_not_null()"))).toBe(true);
    }
  });

  it("ExprSchema still allows a null literal as a conditional branch value and as a call argument", () => {
    const conditional = ExprSchema.safeParse({
      kind: "conditional",
      branches: [{ when: { kind: "call", fn: "is_null", args: [{ kind: "field", name: "x" }] }, then: { kind: "literal", value: null } }],
      else: { kind: "field", name: "x" },
    });
    expect(conditional.success).toBe(true);

    const coalesceCall = ExprSchema.safeParse({ kind: "call", fn: "coalesce", args: [{ kind: "literal", value: null }, { kind: "field", name: "x" }] });
    expect(coalesceCall.success).toBe(true);
  });

  it("collectFieldRefs finds every field across nested calls and binary ops", () => {
    const parsed = parseExpression('concat(first_name, last_name) + qty * price');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(collectFieldRefs(parsed.expr).sort()).toEqual(["first_name", "last_name", "price", "qty"]);
  });

  it("every successful parse also validates against ExprSchema", () => {
    const result = parseExpression('concat(a, "x") * (b + 2)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => ExprSchema.parse(result.expr)).not.toThrow();
    }
  });
});

describe("parseExpression — Math core call-fns (batch 1) arity", () => {
  it("parses 1-arg math fns (abs/ceil/floor/sign/sqrt/int/trunc)", () => {
    for (const fn of ["abs", "ceil", "floor", "sign", "sqrt", "int", "trunc"]) {
      const result = parseExpression(`${fn}(amount)`);
      expect(result).toEqual({ ok: true, expr: { kind: "call", fn, args: [{ kind: "field", name: "amount" }] } });
    }
  });

  it("parses 2-arg math fns (mod/power/quotient/round_to_multiple)", () => {
    for (const fn of ["mod", "power", "quotient", "round_to_multiple"]) {
      const result = parseExpression(`${fn}(amount, 3)`);
      expect(result).toEqual({
        ok: true,
        expr: { kind: "call", fn, args: [{ kind: "field", name: "amount" }, { kind: "literal", value: 3 }] },
      });
    }
  });

  it("parses divide() with 2 or 3 args (optional default-on-zero)", () => {
    expect(parseExpression("divide(a, b)").ok).toBe(true);
    expect(parseExpression("divide(a, b, 0)").ok).toBe(true);
  });

  it("parses round/round_up/round_down with an optional digits arg", () => {
    for (const fn of ["round", "round_up", "round_down"]) {
      expect(parseExpression(`${fn}(price)`).ok).toBe(true);
      expect(parseExpression(`${fn}(price, 2)`).ok).toBe(true);
    }
  });

  it("rejects wrong arity for 1-arg math fns", () => {
    expect(parseExpression("abs(a, b)").ok).toBe(false);
    expect(parseExpression("sqrt()").ok).toBe(false);
  });

  it("rejects wrong arity for 2-arg math fns", () => {
    expect(parseExpression("mod(a)").ok).toBe(false);
    expect(parseExpression("power(a, b, c)").ok).toBe(false);
    expect(parseExpression("round_to_multiple(a)").ok).toBe(false);
  });

  it("rejects divide() with 0, 1, or 4 args", () => {
    expect(parseExpression("divide()").ok).toBe(false);
    expect(parseExpression("divide(a)").ok).toBe(false);
    expect(parseExpression("divide(a, b, c, d)").ok).toBe(false);
  });

  it("rejects round() with more than 2 args", () => {
    expect(parseExpression("round(a, 2, 3)").ok).toBe(false);
  });

  it("every math-fn parse also validates against ExprSchema", () => {
    const result = parseExpression("round(divide(a, b, 0), 2)");
    expect(result.ok).toBe(true);
    if (result.ok) expect(() => ExprSchema.parse(result.expr)).not.toThrow();
  });
});

describe("parseExpression — Math remainder call-fns (batch 2) arity", () => {
  it("parses exp/ln as 1-arg", () => {
    for (const fn of ["exp", "ln"]) {
      const result = parseExpression(`${fn}(amount)`);
      expect(result).toEqual({ ok: true, expr: { kind: "call", fn, args: [{ kind: "field", name: "amount" }] } });
    }
  });

  it("parses log() with 1 arg (natural log) or 2 args (explicit base)", () => {
    expect(parseExpression("log(amount)")).toEqual({
      ok: true,
      expr: { kind: "call", fn: "log", args: [{ kind: "field", name: "amount" }] },
    });
    expect(parseExpression("log(amount, 2)")).toEqual({
      ok: true,
      expr: { kind: "call", fn: "log", args: [{ kind: "field", name: "amount" }, { kind: "literal", value: 2 }] },
    });
  });

  it("rejects wrong arity for exp/ln/log", () => {
    expect(parseExpression("exp()").ok).toBe(false);
    expect(parseExpression("exp(a, b)").ok).toBe(false);
    expect(parseExpression("ln()").ok).toBe(false);
    expect(parseExpression("ln(a, b)").ok).toBe(false);
    expect(parseExpression("log()").ok).toBe(false);
    expect(parseExpression("log(a, b, c)").ok).toBe(false);
  });

  it("every batch 2 math-fn parse also validates against ExprSchema", () => {
    const result = parseExpression("log(exp(ln(amount)), 2)");
    expect(result.ok).toBe(true);
    if (result.ok) expect(() => ExprSchema.parse(result.expr)).not.toThrow();
  });
});
