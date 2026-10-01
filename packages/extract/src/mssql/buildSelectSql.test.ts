import { describe, expect, it } from "vitest";
import type { CatalogTable, FilterCondition } from "../types.js";
import { buildSelectSql } from "./buildSelectSql.js";

const table: CatalogTable = {
  name: "dbo.orders",
  kind: "table",
  columns: [],
  excluded: [],
};

describe("buildSelectSql", () => {
  it("selects plain columns with no casting when none is needed", () => {
    const nativeTypes = new Map([
      ["id", "int"],
      ["name", "nvarchar"],
    ]);
    const { sql, params } = buildSelectSql(table, nativeTypes, ["id", "name"], []);
    expect(sql).toBe("SELECT [id], [name] FROM [dbo].[orders]");
    expect(params).toEqual([]);
  });

  it("casts an exact-numeric column to text and aliases it back to its original name", () => {
    const nativeTypes = new Map([["amount", "decimal"]]);
    const { sql } = buildSelectSql(table, nativeTypes, ["amount"], []);
    expect(sql).toBe("SELECT CAST([amount] AS VARCHAR(MAX)) AS [amount] FROM [dbo].[orders]");
  });

  it("converts datetime-family columns with style 121 (ODBC canonical, no trailing zone)", () => {
    for (const t of ["datetime", "smalldatetime", "datetime2"]) {
      const nativeTypes = new Map([["created_at", t]]);
      const { sql } = buildSelectSql(table, nativeTypes, ["created_at"], []);
      expect(sql).toBe(`SELECT CONVERT(VARCHAR(MAX), [created_at], 121) AS [created_at] FROM [dbo].[orders]`);
    }
  });

  it("converts money/smallmoney with style 2, never a plain CAST (which silently rounds to 2 decimal places and loses money's real 4-digit precision)", () => {
    for (const t of ["money", "smallmoney"]) {
      const nativeTypes = new Map([["cash", t]]);
      const { sql } = buildSelectSql(table, nativeTypes, ["cash"], []);
      expect(sql).toBe(`SELECT CONVERT(VARCHAR(MAX), [cash], 2) AS [cash] FROM [dbo].[orders]`);
    }
  });

  it("casts datetimeoffset with a plain CAST, preserving its own UTC offset in the text", () => {
    const nativeTypes = new Map([["created_at", "datetimeoffset"]]);
    const { sql } = buildSelectSql(table, nativeTypes, ["created_at"], []);
    expect(sql).toBe("SELECT CAST([created_at] AS VARCHAR(MAX)) AS [created_at] FROM [dbo].[orders]");
  });

  it("binds a WHERE filter through ParamSink-style @p placeholders", () => {
    const nativeTypes = new Map([["status", "varchar"]]);
    const filter: FilterCondition[] = [{ column: "status", operator: "eq", value: "open" }];
    const { sql, params } = buildSelectSql(table, nativeTypes, ["status"], filter);
    expect(sql).toBe("SELECT [status] FROM [dbo].[orders] WHERE [status] = @p1");
    expect(params).toEqual(["open"]);
  });

  it("adds a validated TOP(n) clause for a positive integer limit", () => {
    const nativeTypes = new Map([["id", "int"]]);
    const { sql } = buildSelectSql(table, nativeTypes, ["id"], [], 50);
    expect(sql).toBe("SELECT TOP (50) [id] FROM [dbo].[orders]");
  });

  it("rejects a non-positive-integer limit rather than interpolating it unchecked", () => {
    const nativeTypes = new Map([["id", "int"]]);
    expect(() => buildSelectSql(table, nativeTypes, ["id"], [], 0)).toThrow(/positive integer/);
    expect(() => buildSelectSql(table, nativeTypes, ["id"], [], 1.5)).toThrow(/positive integer/);
    expect(() => buildSelectSql(table, nativeTypes, ["id"], [], -5)).toThrow(/positive integer/);
  });

  it("throws if a requested column has no known native type", () => {
    const nativeTypes = new Map<string, string>();
    expect(() => buildSelectSql(table, nativeTypes, ["ghost"], [])).toThrow(/no native type known/);
  });
});
