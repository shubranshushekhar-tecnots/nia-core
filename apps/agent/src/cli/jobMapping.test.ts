import { describe, expect, it } from "vitest";
import type { CatalogTable } from "@nia/extract";
import type { SchemaColumn } from "../planometry/types.js";
import { buildMapping, norm, parseMapOverrides } from "./jobMapping.js";

function sourceTable(columns: CatalogTable["columns"], excluded: CatalogTable["excluded"] = []): CatalogTable {
  return { name: "dbo.Source", kind: "table", columns, excluded };
}

describe("norm", () => {
  it("lowercases and strips spaces, underscores and dashes", () => {
    expect(norm("First Name")).toBe("firstname");
    expect(norm("first_name")).toBe("firstname");
    expect(norm("First-Name")).toBe("firstname");
  });
});

describe("parseMapOverrides", () => {
  it("parses source=target pairs", () => {
    expect(parseMapOverrides(["Id=CustomerId", "Name=FullName"])).toEqual([
      { source: "Id", target: "CustomerId" },
      { source: "Name", target: "FullName" },
    ]);
  });

  it("throws on a malformed entry with no '='", () => {
    expect(() => parseMapOverrides(["IdOnly"])).toThrow();
  });
});

describe("buildMapping", () => {
  it("auto-matches by exact name first, then by norm()", () => {
    const source = sourceTable([
      { name: "Id", type: "number", nullable: false },
      { name: "First_Name", type: "text", nullable: true },
    ]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "FirstName", type: "Text", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], []);
    expect(plan.errors).toEqual([]);
    expect(plan.pairs).toEqual([
      { source: "Id", target: "Id" },
      { source: "First_Name", target: "FirstName" },
    ]);
  });

  it("lets a --map override win over auto-match", () => {
    const source = sourceTable([
      { name: "Id", type: "number", nullable: false },
      { name: "LegacyName", type: "text", nullable: true },
      { name: "FirstName", type: "text", nullable: true },
    ]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "FirstName", type: "Text", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], [{ source: "LegacyName", target: "FirstName" }]);
    expect(plan.errors).toEqual([]);
    expect(plan.pairs).toContainEqual({ source: "LegacyName", target: "FirstName" });
    expect(plan.pairs).not.toContainEqual({ source: "FirstName", target: "FirstName" });
  });

  it("lists unmapped non-key target columns as sent as null", () => {
    const source = sourceTable([{ name: "Id", type: "number", nullable: false }]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "Notes", type: "Text", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], []);
    expect(plan.errors).toEqual([]);
    expect(plan.sentAsNull).toEqual(["Notes"]);
  });

  it("refuses when a target key column is left unmapped", () => {
    const source = sourceTable([{ name: "Name", type: "text", nullable: true }]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "Name", type: "Text", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], []);
    expect(plan.errors.some((e) => e.includes('target key column "Id" must be mapped'))).toBe(true);
  });

  it("refuses when two sources are mapped to the same target", () => {
    const source = sourceTable([
      { name: "Id", type: "number", nullable: false },
      { name: "A", type: "text", nullable: true },
      { name: "B", type: "text", nullable: true },
    ]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "Name", type: "Text", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], [
      { source: "A", target: "Name" },
      { source: "B", target: "Name" },
    ]);
    expect(plan.errors.some((e) => e.includes("more than one source column is mapped to the same target column"))).toBe(true);
  });

  it("refuses an unknown target column", () => {
    const source = sourceTable([{ name: "Id", type: "number", nullable: false }]);
    const targetColumns: SchemaColumn[] = [{ name: "Id", type: "Number", isKey: true }];
    const plan = buildMapping(source, targetColumns, ["Id"], [{ source: "Id", target: "DoesNotExist" }]);
    expect(plan.errors.some((e) => e.includes('target column "DoesNotExist" does not exist'))).toBe(true);
  });

  it("refuses an unknown or excluded source column", () => {
    const source = sourceTable(
      [
        { name: "Id", type: "number", nullable: false },
        { name: "Name", type: "text", nullable: false },
      ],
      [{ name: "Blob", nativeType: "varbinary(max)", reason: "binary types are excluded" }],
    );
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "Name", type: "Text", isKey: false },
      { name: "Avatar", type: "Text", isKey: false },
    ];

    const unknownSource = buildMapping(source, targetColumns, ["Id"], [{ source: "Ghost", target: "Name" }]);
    expect(unknownSource.errors.some((e) => e.includes('source column "Ghost" does not exist in the catalog'))).toBe(true);

    const excludedSource = buildMapping(source, targetColumns, ["Id"], [{ source: "Blob", target: "Avatar" }]);
    expect(excludedSource.errors.some((e) => e.includes('source column "Blob" is of an excluded type'))).toBe(true);
  });

  it("refuses a disallowed type pair", () => {
    const source = sourceTable([
      { name: "Id", type: "number", nullable: false },
      { name: "Description", type: "text", nullable: true },
    ]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "Amount", type: "Number", isKey: false },
    ];
    const plan = buildMapping(source, targetColumns, ["Id"], [{ source: "Description", target: "Amount" }]);
    expect(plan.errors.some((e) => e.includes("cannot be mapped to target column"))).toBe(true);
  });

  it("a DateTime mapping without sourceTimeZone is refused", () => {
    const source = sourceTable([
      { name: "Id", type: "number", nullable: false },
      { name: "CreatedAt", type: "datetime", nullable: true },
    ]);
    const targetColumns: SchemaColumn[] = [
      { name: "Id", type: "Number", isKey: true },
      { name: "CreatedAt", type: "DateTime", isKey: false },
    ];
    const withoutZone = buildMapping(source, targetColumns, ["Id"], []);
    expect(withoutZone.errors.some((e) => e.includes("has no sourceTimeZone set"))).toBe(true);

    const withZone = buildMapping(source, targetColumns, ["Id"], [], "America/New_York");
    expect(withZone.errors).toEqual([]);
  });
});
