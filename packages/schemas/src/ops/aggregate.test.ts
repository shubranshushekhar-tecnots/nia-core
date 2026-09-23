import { describe, it, expect } from "vitest";
import { aggregateOp } from "./aggregate.js";
import type { AggregateStep, AggregationSpec } from "../nodeConfig.js";
import type { NiaSchema } from "../niaType.js";

const input: NiaSchema = {
  fields: {
    region: { type: { kind: "string" }, nullable: false },
    price: { type: { kind: "float" }, nullable: false },
  },
};

const step = (aggregations: AggregationSpec[]): AggregateStep => ({
  kind: "aggregate",
  groupBy: ["region"],
  aggregations,
});

describe("aggregateOp.outputSchema", () => {
  // A wrong entry here would create destination columns with the wrong
  // type/nullability at schema-compile time — this table is the only thing
  // testing aggregate.ts's per-fn output typing.
  const cases: Array<{ fn: AggregationSpec["fn"]; field: string | null; expectedKind: string; expectedNullable: boolean }> = [
    { fn: "count", field: null, expectedKind: "integer", expectedNullable: false },
    { fn: "count_field", field: "price", expectedKind: "integer", expectedNullable: false },
    { fn: "count_distinct", field: "price", expectedKind: "integer", expectedNullable: false },
    { fn: "sum", field: "price", expectedKind: "float", expectedNullable: false },
    { fn: "avg", field: "price", expectedKind: "float", expectedNullable: true },
    { fn: "min", field: "price", expectedKind: "float", expectedNullable: true },
    { fn: "max", field: "price", expectedKind: "float", expectedNullable: true },
  ];

  for (const { fn, field, expectedKind, expectedNullable } of cases) {
    it(`${fn} => ${expectedKind}, nullable=${expectedNullable}`, () => {
      const result = aggregateOp.outputSchema(input, step([{ fn, field, alias: "out" }]));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.schema.fields.out).toEqual({ type: { kind: expectedKind }, nullable: expectedNullable });
        // groupBy field passes through unchanged.
        expect(result.schema.fields.region).toEqual(input.fields.region);
      }
    });
  }

  it("fails naming the column when min/max references an unknown field", () => {
    const result = aggregateOp.outputSchema(input, step([{ fn: "max", field: "nope", alias: "out" }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nope");
  });

  it("fails naming the column when groupBy references an unknown field", () => {
    const result = aggregateOp.outputSchema(input, { kind: "aggregate", groupBy: ["nope"], aggregations: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nope");
  });
});
