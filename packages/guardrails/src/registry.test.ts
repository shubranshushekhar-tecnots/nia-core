import { CONNECTOR_MANIFESTS } from "@nia/schemas";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_REGISTRY, validateBeforeDispatch } from "./registry.js";

describe("guardrail registry completeness", () => {
  it("has a registered validator for every manifest with the queryable capability", () => {
    const missing = Object.values(CONNECTOR_MANIFESTS)
      .filter((m) => m.capabilities.includes("queryable"))
      .map((m) => m.id)
      .filter((id) => !GUARDRAIL_REGISTRY[id]);

    expect(missing).toEqual([]);
  });
});

describe("validateBeforeDispatch", () => {
  it("rejects an unregistered connector id", () => {
    const result = validateBeforeDispatch(
      "unknown-connector",
      { kind: "sql", sql: "SELECT 1", params: [] },
      { connectionId: "c1" },
    );
    expect(result.ok).toBe(false);
  });

  it("dispatches to the mysql validator", () => {
    const result = validateBeforeDispatch(
      "mysql",
      { kind: "sql", sql: "SELECT 1", params: [] },
      { connectionId: "c1" },
    );
    expect(result.ok).toBe(true);
  });

  it("dispatches to the mongodb validator", () => {
    const result = validateBeforeDispatch(
      "mongodb",
      { kind: "mongo", collection: "orders", pipeline: [] },
      { connectionId: "c1" },
    );
    expect(result.ok).toBe(true);
  });

  it("dispatches to the supabase (postgres) validator", () => {
    const result = validateBeforeDispatch(
      "supabase",
      { kind: "sql", sql: "SELECT 1", params: [] },
      { connectionId: "c1" },
    );
    expect(result.ok).toBe(true);
  });
});
