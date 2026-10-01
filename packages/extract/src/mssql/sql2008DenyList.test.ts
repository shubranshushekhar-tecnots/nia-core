import { describe, expect, it } from "vitest";
import type { CatalogTable, FilterCondition } from "../types.js";
import { buildSelectSql } from "./buildSelectSql.js";
import { COLUMNS_SQL, TABLES_SQL } from "./introspect.js";

/**
 * GMS (the first customer) runs SQL Server 2008 — several versions
 * behind the throwaway `mssql.integration.test.ts` harness container
 * (SQL Server 2022), which happily accepts 2012+ syntax and so can never
 * catch a regression that only breaks 2008. This test instead statically
 * scans every piece of SQL this module can generate against a deny-list
 * of syntax introduced in SQL Server 2012 or later:
 *   - TRY_CAST / TRY_CONVERT (2012)
 *   - CONCAT (2012)
 *   - FORMAT (2012)
 *   - IIF (2012)
 *   - OFFSET ... FETCH (2012)
 *   - STRING_SPLIT (2016)
 */
const DENY_LIST: RegExp[] = [
  /\bTRY_CAST\s*\(/i,
  /\bTRY_CONVERT\s*\(/i,
  /\bCONCAT\s*\(/i,
  /\bFORMAT\s*\(/i,
  /\bIIF\s*\(/i,
  /\bOFFSET\s+[^;]*\bFETCH\b/i,
  /\bSTRING_SPLIT\s*\(/i,
];

function assertSql2008Safe(sql: string): void {
  for (const pattern of DENY_LIST) {
    expect(sql, `generated SQL used a 2012+ feature (${pattern}): ${sql}`).not.toMatch(pattern);
  }
}

const table: CatalogTable = { name: "dbo.orders", kind: "table", columns: [], excluded: [] };

// Every native type this module knows how to CAST/CONVERT, one at a time.
const CAST_TYPES = [
  "int",
  "smallint",
  "tinyint",
  "nvarchar",
  "varchar",
  "char",
  "nchar",
  "xml",
  "uniqueidentifier",
  "bit",
  "float",
  "real",
  "date",
  "decimal",
  "numeric",
  "bigint",
  "time",
  "money",
  "smallmoney",
  "datetime",
  "smalldatetime",
  "datetime2",
  "datetimeoffset",
];

const ALL_FILTERS: FilterCondition[] = [
  { column: "a", operator: "eq", value: "x" },
  { column: "a", operator: "neq", value: "x" },
  { column: "a", operator: "gt", value: 1 },
  { column: "a", operator: "gte", value: 1 },
  { column: "a", operator: "lt", value: 1 },
  { column: "a", operator: "lte", value: 1 },
  { column: "a", operator: "between", low: 1, high: 2 },
  { column: "a", operator: "in", values: [1, 2, 3] },
  { column: "a", operator: "startsWith", value: "abc%_" },
  { column: "a", operator: "isNull" },
  { column: "a", operator: "isNotNull" },
];

describe("SQL Server 2008 compatibility (GMS)", () => {
  it("never uses a 2012+ CAST/CONVERT expression for any supported native type", () => {
    for (const t of CAST_TYPES) {
      const nativeTypes = new Map([["col", t]]);
      const { sql } = buildSelectSql(table, nativeTypes, ["col"], []);
      assertSql2008Safe(sql);
    }
  });

  it("never uses a 2012+ feature in any WHERE clause, including every filter operator", () => {
    const nativeTypes = new Map([["a", "nvarchar"]]);
    for (const filter of ALL_FILTERS) {
      const { sql } = buildSelectSql(table, nativeTypes, ["a"], [filter]);
      assertSql2008Safe(sql);
    }
    // All filters AND-joined together, the realistic worst case.
    const { sql } = buildSelectSql(table, nativeTypes, ["a"], ALL_FILTERS);
    assertSql2008Safe(sql);
  });

  it("uses TOP (n), never OFFSET/FETCH, for a row limit", () => {
    const nativeTypes = new Map([["id", "int"]]);
    const { sql } = buildSelectSql(table, nativeTypes, ["id"], [], 10);
    expect(sql).toContain("TOP (10)");
    assertSql2008Safe(sql);
  });

  it("the catalog's introspection queries use only INFORMATION_SCHEMA (available on SQL Server 2008)", () => {
    assertSql2008Safe(TABLES_SQL);
    assertSql2008Safe(COLUMNS_SQL);
    expect(TABLES_SQL).toContain("INFORMATION_SCHEMA.TABLES");
    expect(COLUMNS_SQL).toContain("INFORMATION_SCHEMA.COLUMNS");
  });
});
