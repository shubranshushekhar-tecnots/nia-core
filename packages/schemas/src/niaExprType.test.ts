import { describe, it, expect } from "vitest";
import { typeOfExpr } from "./niaExprType.js";
import type { CallFn, Expr } from "./expression.js";
import type { NiaSchema } from "./niaType.js";

const schema: NiaSchema = {
  fields: {
    amount: { type: { kind: "string" }, nullable: true },
  },
};

const call = (fn: CallFn, args: Expr[] = [{ kind: "field", name: "amount" }]): Expr => ({ kind: "call", fn, args });

describe("typeOfExpr — coercion functions", () => {
  // A wrong entry here would create destination columns with the wrong
  // type at schema-compile time — this table is the only thing testing
  // niaExprType.ts's CALL_FN_TYPE mapping for these six.
  const cases: Array<{ fn: CallFn; expectedKind: string }> = [
    { fn: "to_number", expectedKind: "float" },
    { fn: "to_integer", expectedKind: "integer" },
    { fn: "to_boolean", expectedKind: "boolean" },
    { fn: "to_date", expectedKind: "date" },
    { fn: "parse_date", expectedKind: "date" },
    { fn: "to_text", expectedKind: "string" },
  ];

  for (const { fn, expectedKind } of cases) {
    it(`${fn}(...) => "${expectedKind}"`, () => {
      const result = typeOfExpr(call(fn), schema);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.type.kind).toBe(expectedKind);
    });
  }

  it("a coercion call's result type is fixed by the function itself, independent of its argument's own type", () => {
    // Unlike `field`/`binary`/`coalesce`/`conditional`, a plain call's
    // output type never depends on its arguments' types (a coercion
    // function's return type is the same regardless of input) — so
    // typeOfExpr does not need to recurse into a plain call's args to
    // determine its own type. Field-reference validity for a call's own
    // arguments is a separate concern (checkConfig/collectFieldRefs), not
    // typeOfExpr's.
    const result = typeOfExpr(call("to_number"), schema);
    expect(result.ok).toBe(true);
  });

  it("fails naming the column for a bare reference to an unknown field", () => {
    const result = typeOfExpr({ kind: "field", name: "nope" }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nope");
  });
});
