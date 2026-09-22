import { describe, expect, it } from "vitest";
import { flattenDocuments } from "./flatten.js";

describe("flattenDocuments", () => {
  it("flattens nested plain objects into dotted-path columns", () => {
    const result = flattenDocuments([{ a: 1, b: { c: 2, d: { e: 3 } } }]);
    expect(result.columns).toEqual(["a", "b.c", "b.d.e"]);
    expect(result.rows).toEqual([{ a: 1, "b.c": 2, "b.d.e": 3 }]);
  });

  it("does not descend into arrays of scalars", () => {
    const result = flattenDocuments([{ tags: ["a", "b", "c"] }]);
    expect(result.columns).toEqual(["tags"]);
    expect(result.rows[0].tags).toBe(JSON.stringify(["a", "b", "c"]));
    expect(result.arrayColumns.has("tags")).toBe(true);
  });

  it("does not descend into arrays of objects", () => {
    const result = flattenDocuments([{ items: [{ id: 1 }, { id: 2 }] }]);
    expect(result.columns).toEqual(["items"]);
    expect(result.rows[0].items).toBe(JSON.stringify([{ id: 1 }, { id: 2 }]));
  });

  it("does not descend into arrays nested inside arrays", () => {
    const result = flattenDocuments([{ matrix: [[1, 2], [3, 4]] }]);
    expect(result.columns).toEqual(["matrix"]);
    expect(result.rows[0].matrix).toBe(JSON.stringify([[1, 2], [3, 4]]));
  });

  it("unions columns across documents and sorts them alphabetically regardless of field order", () => {
    const result = flattenDocuments([{ z: 1, a: 2 }, { m: 3 }]);
    expect(result.columns).toEqual(["a", "m", "z"]);
  });

  it("fills missing fields with null", () => {
    const result = flattenDocuments([{ a: 1 }, { b: 2 }]);
    expect(result.rows).toEqual([
      { a: 1, b: null },
      { a: null, b: 2 },
    ]);
  });

  it("produces the same column order regardless of document processing order", () => {
    const r1 = flattenDocuments([{ z: 1 }, { a: 2 }]);
    const r2 = flattenDocuments([{ a: 2 }, { z: 1 }]);
    expect(r1.columns).toEqual(r2.columns);
  });

  it("flags a top-level field name that itself contains a literal '.' as degraded, without merging it into a nested path", () => {
    const result = flattenDocuments([{ "a.b": 1, c: 2 }]);
    expect(result.columns).toEqual(["a.b", "c"]);
    expect(result.degradedColumns.has("a.b")).toBe(true);
    expect(result.degradedColumns.has("c")).toBe(false);
    expect(result.rows).toEqual([{ "a.b": 1, c: 2 }]);
  });

  it("does not flag a genuinely nested path built from non-dotted keys as degraded", () => {
    const result = flattenDocuments([{ a: { b: 1 } }]);
    expect(result.degradedColumns.size).toBe(0);
  });

  it("stops descending and JSON.stringify's an object value under a dotted key, flagging it degraded", () => {
    const result = flattenDocuments([{ "a.b": { c: 1, d: 2 } }]);
    expect(result.columns).toEqual(["a.b"]);
    expect(result.degradedColumns.has("a.b")).toBe(true);
    expect(result.rows[0]!["a.b"]).toBe(JSON.stringify({ c: 1, d: 2 }));
  });

  it("still marks an array under a dotted key as an arrayColumn, in addition to degraded", () => {
    const result = flattenDocuments([{ "a.b": [1, 2] }]);
    expect(result.arrayColumns.has("a.b")).toBe(true);
    expect(result.degradedColumns.has("a.b")).toBe(true);
  });
});
