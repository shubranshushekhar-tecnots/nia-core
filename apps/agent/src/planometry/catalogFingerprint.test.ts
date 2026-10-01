import { describe, expect, it } from "vitest";
import { computeCatalogFingerprint } from "./catalogFingerprint.js";
import type { Catalog } from "@nia/extract";

const baseCatalog: Catalog = {
  generatedAt: "2026-01-01T00:00:00Z",
  sourceTimeZone: "UTC",
  tables: [{ name: "dbo.t", kind: "table", columns: [{ name: "id", type: "number", nullable: false }], excluded: [] }],
};

describe("computeCatalogFingerprint", () => {
  it("is stable across different generatedAt timestamps for the same schema", () => {
    const later: Catalog = { ...baseCatalog, generatedAt: "2026-06-01T00:00:00Z" };
    expect(computeCatalogFingerprint(baseCatalog)).toBe(computeCatalogFingerprint(later));
  });

  it("changes when a column is added", () => {
    const changed: Catalog = {
      ...baseCatalog,
      tables: [{ ...baseCatalog.tables[0]!, columns: [...baseCatalog.tables[0]!.columns, { name: "new_col", type: "text", nullable: true }] }],
    };
    expect(computeCatalogFingerprint(baseCatalog)).not.toBe(computeCatalogFingerprint(changed));
  });
});
