import { describe, expect, it } from "vitest";
import { buildBulkWriteOps } from "./writeOps.js";

describe("buildBulkWriteOps", () => {
  it("builds a flat replaceOne when no column name contains a dot", () => {
    const ops = buildBulkWriteOps(["a", "b"], ["a"], [[1, 2]]);
    expect(ops).toEqual([
      { replaceOne: { filter: { a: 1 }, replacement: { a: 1, b: 2 }, upsert: true } },
    ]);
  });

  it("un-flattens a dotted column name into a nested replacement document", () => {
    const ops = buildBulkWriteOps(["a.b", "c"], ["c"], [[1, 2]]);
    expect(ops).toEqual([
      { replaceOne: { filter: { c: 2 }, replacement: { a: { b: 1 }, c: 2 }, upsert: true } },
    ]);
  });

  it("un-flattens multiple dotted columns sharing a common prefix into one nested object", () => {
    const ops = buildBulkWriteOps(["a.b", "a.c"], ["a.b"], [[1, 2]]);
    expect(ops).toEqual([
      { replaceOne: { filter: { "a.b": 1 }, replacement: { a: { b: 1, c: 2 } }, upsert: true } },
    ]);
  });

  it("keeps the upsertKeys filter on the original dotted column name via Mongo dot-notation, not the rebuilt nested shape", () => {
    const ops = buildBulkWriteOps(["a.b", "c"], ["a.b"], [[1, 2]]);
    expect(ops[0]!.replaceOne!.filter).toEqual({ "a.b": 1 });
    expect(ops[0]!.replaceOne!.replacement).toEqual({ a: { b: 1 }, c: 2 });
  });

  it("parses a JSON-array-stringified value back into a real array in the replacement document", () => {
    const ops = buildBulkWriteOps(["tags"], ["tags"], [[JSON.stringify(["x", "y"])]]);
    expect(ops[0]!.replaceOne!.replacement).toEqual({ tags: ["x", "y"] });
    expect(ops[0]!.replaceOne!.filter).toEqual({ tags: ["x", "y"] });
  });

  it("leaves a plain string value untouched even if it happens to parse as JSON but not as an array", () => {
    const ops = buildBulkWriteOps(["n"], [], [["123"]]);
    expect(ops[0]!.replaceOne!.replacement).toEqual({ n: "123" });
  });

  it("leaves a JSON-object-stringified value untouched (only arrays get reparsed)", () => {
    const stringified = JSON.stringify({ x: 1 });
    const ops = buildBulkWriteOps(["obj"], [], [[stringified]]);
    expect(ops[0]!.replaceOne!.replacement).toEqual({ obj: stringified });
  });

  it("produces one replaceOne per row", () => {
    const ops = buildBulkWriteOps(["a"], ["a"], [[1], [2]]);
    expect(ops).toHaveLength(2);
    expect(ops[0]!.replaceOne!.filter).toEqual({ a: 1 });
    expect(ops[1]!.replaceOne!.filter).toEqual({ a: 2 });
  });
});
