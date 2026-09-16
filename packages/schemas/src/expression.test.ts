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
    const result = parseExpression("upper(name)");
    // "upper" isn't in CALL_FNS, so it's parsed as a bare field ref, then the
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
