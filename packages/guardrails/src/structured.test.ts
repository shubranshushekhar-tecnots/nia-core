import type { QueryPayload } from "@nia/schemas";
import { describe, expect, it } from "vitest";
import { validateBeforeDispatch } from "./registry.js";
import { validateStructuredQuery } from "./structured.js";

const basePayload: QueryPayload = {
  kind: "structured",
  table: "dbo.orders",
  columns: ["id", "total"],
  filter: [{ column: "status", operator: "eq", value: "open" }],
  cursor: { column: "id", value: 100 },
  limit: 500,
};

describe("validateStructuredQuery — allowed", () => {
  it("accepts a well-formed structured payload with table, columns, filter and keyset cursor", () => {
    const result = validateStructuredQuery(basePayload, { connectionId: "c1" });
    expect(result.ok).toBe(true);
  });

  it("is registered for sqlserver-agent and reachable via validateBeforeDispatch", () => {
    const result = validateBeforeDispatch("sqlserver-agent", basePayload, { connectionId: "c1" });
    expect(result.ok).toBe(true);
  });
});

describe("validateStructuredQuery — refused", () => {
  it("rejects an unknown filter operator", () => {
    const query: QueryPayload = {
      ...basePayload,
      filter: [{ column: "status", operator: "contains" as never, value: "open" } as never],
    };
    const result = validateStructuredQuery(query, { connectionId: "c1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a row limit above the chunk cap", () => {
    const query: QueryPayload = { ...basePayload, limit: 1001 };
    const result = validateStructuredQuery(query, { connectionId: "c1" });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty table identifier", () => {
    const query: QueryPayload = { ...basePayload, table: "" };
    const result = validateStructuredQuery(query, { connectionId: "c1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a query of the wrong kind", () => {
    const result = validateStructuredQuery({ kind: "sql", sql: "SELECT 1", params: [] }, { connectionId: "c1" });
    expect(result.ok).toBe(false);
  });

  it("cannot be dispatched to a different connector type (mysql)", () => {
    const result = validateBeforeDispatch("mysql", basePayload, { connectionId: "c1" });
    expect(result.ok).toBe(false);
  });
});
