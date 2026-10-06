import { validateBeforeDispatch } from "@nia/guardrails";
import { describe, expect, it } from "vitest";
import { buildEtlReadQuery } from "./queryBuilder.js";

describe("buildEtlReadQuery — structured (agent-backed) sources — allowed", () => {
  it("produces a structured payload with table, columns, filter and keyset cursor, accepted by validation", () => {
    const query = buildEtlReadQuery("structured", { namespace: "dbo", name: "orders" }, null, "id", 100, 500);

    expect(query.kind).toBe("structured");
    if (query.kind !== "structured") throw new Error("expected structured payload");
    expect(query.table).toBe("dbo.orders");
    expect(Array.isArray(query.columns)).toBe(true);
    expect(Array.isArray(query.filter)).toBe(true);
    expect(query.cursor).toEqual({ column: "id", value: 100 });

    const result = validateBeforeDispatch("sqlserver-agent", query, { connectionId: "c1" });
    expect(result.ok).toBe(true);
  });

  it("still produces SQL for a PostgreSQL source (regression)", () => {
    const query = buildEtlReadQuery("postgres", { namespace: "public", name: "orders" }, null, "id", 100, 500);
    expect(query.kind).toBe("sql");
  });
});

describe("buildEtlReadQuery — structured sources — refused", () => {
  it("throws when there is no key to page by", () => {
    expect(() => buildEtlReadQuery("structured", { namespace: "dbo", name: "orders" }, null, undefined, null, 500)).toThrow();
  });
});
