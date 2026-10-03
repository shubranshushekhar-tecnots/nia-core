import { describe, expect, it } from "vitest";
import { compileWhereClause, createParamSink, resolveParamSink, type ExtractType, type WhereClauseAdapter } from "@nia/extract";
import { quoteIdent } from "@nia/extract/mssql";
import { ParameterError, resolveJobFilter, resolveRelativeDateToken } from "./parameters.js";
import type { JobFilterCondition } from "./parameters.js";

const adapter: WhereClauseAdapter = { quoteIdent, likeEscapeChar: "\\" };

describe("resolveJobFilter -> compileWhereClause", () => {
  it("produces a query with bound parameters and no literal values in the SQL text", () => {
    const jobFilter: JobFilterCondition[] = [
      { column: "Status", operator: "eq", value: { param: "status" } },
      { column: "CreatedAt", operator: "gte", value: { param: "fromDate" } },
    ];
    const columnTypes: Record<string, ExtractType> = { Status: "text", CreatedAt: "datetime" };
    const savedParams = { status: "active", fromDate: "2024-01-01" };

    const { filter } = resolveJobFilter(jobFilter, columnTypes, savedParams, undefined, "UTC");

    const sink = createParamSink();
    const fragments = compileWhereClause(filter, adapter, sink);
    const rawSql = `SELECT * FROM [dbo].[Source] WHERE ${fragments.join(" AND ")}`;
    const { sql, params } = resolveParamSink(sink, rawSql, (i) => `@p${i}`);

    expect(sql).not.toContain("active");
    expect(sql).not.toContain("2024-01-01");
    expect(sql).toContain("@p1");
    expect(sql).toContain("@p2");
    expect(params).toEqual(["active", "2024-01-01"]);
  });
});

describe("resolveJobFilter: param overrides", () => {
  it("job run --param overrides the saved value for one run and the saved value is unchanged afterwards", () => {
    const jobFilter: JobFilterCondition[] = [{ column: "CreatedAt", operator: "gte", value: { param: "fromDate" } }];
    const columnTypes: Record<string, ExtractType> = { CreatedAt: "date" };
    const savedParams = { fromDate: "2024-01-01" };

    const { filter } = resolveJobFilter(jobFilter, columnTypes, savedParams, { fromDate: "2024-06-01" }, "UTC");

    expect(filter).toEqual([{ column: "CreatedAt", operator: "gte", value: "2024-06-01" }]);
    expect(savedParams).toEqual({ fromDate: "2024-01-01" });
  });
});

describe("resolveRelativeDateToken", () => {
  it("today-30d resolves in the connection's timezone", () => {
    // 23:30 UTC on Mar 1 is already 13:30 on Mar 2 in Pacific/Kiritimati (UTC+14) — the local date differs from the UTC date.
    const now = new Date("2024-03-01T23:30:00.000Z");
    expect(resolveRelativeDateToken("today-30d", "Pacific/Kiritimati", now)).toBe("2024-02-01");
  });
});

describe("resolveJobFilter: refusals", () => {
  it("refuses a parameter value that does not fit the column type", () => {
    const jobFilter: JobFilterCondition[] = [{ column: "Amount", operator: "gte", value: { param: "minAmount" } }];
    const columnTypes: Record<string, ExtractType> = { Amount: "number" };
    const savedParams = { minAmount: "not-a-number" };

    expect(() => resolveJobFilter(jobFilter, columnTypes, savedParams, undefined, "UTC")).toThrow(ParameterError);
  });

  it("refuses a relative-date token on a non-date column", () => {
    const jobFilter: JobFilterCondition[] = [{ column: "Status", operator: "eq", value: { param: "status" } }];
    const columnTypes: Record<string, ExtractType> = { Status: "text" };
    const savedParams = { status: "today" };

    expect(() => resolveJobFilter(jobFilter, columnTypes, savedParams, undefined, "UTC")).toThrow(ParameterError);
  });

  it("refuses (stops before extraction) a run with a parameter that has no value", () => {
    const jobFilter: JobFilterCondition[] = [{ column: "CreatedAt", operator: "gte", value: { param: "fromDate" } }];
    const columnTypes: Record<string, ExtractType> = { CreatedAt: "date" };

    expect(() => resolveJobFilter(jobFilter, columnTypes, {}, undefined, "UTC")).toThrow(ParameterError);
  });
});
