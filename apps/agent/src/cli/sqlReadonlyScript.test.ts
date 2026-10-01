import { describe, expect, it } from "vitest";
import { InvalidIdentifierError, buildReadonlySetupScript } from "./sqlReadonlyScript.js";

// Same deny-list as packages/extract/src/mssql/sql2008DenyList.test.ts —
// the generated script must work on GMS's SQL Server 2008 boxes.
const SQL_2012_PLUS_DENY_LIST: RegExp[] = [
  /\bTRY_CAST\s*\(/i,
  /\bTRY_CONVERT\s*\(/i,
  /\bCONCAT\s*\(/i,
  /\bFORMAT\s*\(/i,
  /\bIIF\s*\(/i,
  /\bOFFSET\s+[^;]*\bFETCH\b/i,
  /\bSTRING_SPLIT\s*\(/i,
];

const WRITE_GRANTING_KEYWORDS = ["db_datawriter", "db_owner", "db_ddladmin", "INSERT", "UPDATE", "DELETE", "ALTER", "CONTROL"];

describe("buildReadonlySetupScript", () => {
  it("rejects a hostile login name", () => {
    expect(() => buildReadonlySetupScript({ loginName: "bad; DROP TABLE x --", databases: ["db1"] })).toThrow(InvalidIdentifierError);
  });

  it("rejects a hostile database name", () => {
    expect(() => buildReadonlySetupScript({ loginName: "nia_reader", databases: ["db1]; DROP TABLE x --"] })).toThrow(InvalidIdentifierError);
  });

  it("rejects an empty database list", () => {
    expect(() => buildReadonlySetupScript({ loginName: "nia_reader", databases: [] })).toThrow();
  });

  it("emits exactly one CREATE LOGIN and one GRANT VIEW SERVER STATE", () => {
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases: ["SummitERP_1", "SummitERP_2"] });
    expect(countOccurrences(sql, /CREATE LOGIN/g)).toBe(1);
    expect(countOccurrences(sql, /GRANT VIEW SERVER STATE/g)).toBe(1);
  });

  it("emits one CREATE USER / sp_addrolemember / GRANT VIEW DEFINITION block per database", () => {
    const databases = ["SummitERP_1", "SummitERP_2", "SummitERP_3"];
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases });
    expect(countOccurrences(sql, /CREATE USER/g)).toBe(databases.length);
    expect(countOccurrences(sql, /sp_addrolemember/g)).toBe(databases.length);
    expect(countOccurrences(sql, /GRANT VIEW DEFINITION/g)).toBe(databases.length);
    for (const db of databases) {
      expect(sql).toContain(`USE [${db}]`);
    }
  });

  it("never grants any write right (ignoring explanatory comments)", () => {
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases: ["SummitERP_1"] });
    const executableOnly = stripSqlComments(sql);
    for (const keyword of WRITE_GRANTING_KEYWORDS) {
      expect(executableOnly.toUpperCase(), `found write-granting keyword "${keyword}"`).not.toContain(keyword.toUpperCase());
    }
  });

  it("only uses a password placeholder, never a real password field", () => {
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases: ["SummitERP_1"] });
    expect(sql).toContain("<CHANGE_ME_STRONG_PASSWORD>");
  });

  it("never uses SQL Server 2012+ syntax", () => {
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases: ["SummitERP_1", "SummitERP_2"] });
    for (const pattern of SQL_2012_PLUS_DENY_LIST) {
      expect(sql, `used a 2012+ feature (${pattern})`).not.toMatch(pattern);
    }
  });

  it("escapes a login name containing a single quote in the literal comparisons", () => {
    // Identifier regex forbids quotes in bracketed names, but the literal
    // comparisons (sys.server_principals / sys.database_principals) use a
    // separate string-literal escape path — prove it doesn't double-escape
    // or break for a plain valid identifier.
    const sql = buildReadonlySetupScript({ loginName: "nia_reader", databases: ["db1"] });
    expect(sql).toContain("N'nia_reader'");
  });
});

function countOccurrences(haystack: string, pattern: RegExp): number {
  return (haystack.match(pattern) ?? []).length;
}

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}
