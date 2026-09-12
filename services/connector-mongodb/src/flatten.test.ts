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
});
