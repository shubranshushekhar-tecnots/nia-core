import { describe, expect, it } from "vitest";
import { resolveColumn, resolveTable, UnknownColumnError, UnknownTableError } from "./catalog.js";
import type { Catalog } from "./types.js";

const catalog: Catalog = {
  generatedAt: "2024-01-01T00:00:00.000Z",
  sourceTimeZone: "UTC",
  tables: [
    {
      name: "dbo.customers",
      kind: "table",
      columns: [
        { name: "id", type: "number", nullable: false },
        { name: "name", type: "text", nullable: true },
      ],
      excluded: [],
      primaryKey: ["id"],
    },
  ],
};

describe("resolveTable", () => {
  it("returns the exact-match table", () => {
    expect(resolveTable(catalog, "dbo.customers").name).toBe("dbo.customers");
  });

  it("rejects an unknown table instead of parsing it", () => {
    expect(() => resolveTable(catalog, "dbo.customers; DROP TABLE x")).toThrow(UnknownTableError);
    expect(() => resolveTable(catalog, "customers")).toThrow(UnknownTableError);
  });
});

describe("resolveColumn", () => {
  const table = resolveTable(catalog, "dbo.customers");

  it("returns the exact-match column", () => {
    expect(resolveColumn(table, "id").type).toBe("number");
  });

  it("rejects an unknown column", () => {
    expect(() => resolveColumn(table, "id'; DROP TABLE x; --")).toThrow(UnknownColumnError);
  });
});
