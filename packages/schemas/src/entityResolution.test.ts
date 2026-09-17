import { describe, expect, it, vi } from "vitest";
import { resolveSourceEntity, findPersistedEntity, fieldNamesForSource } from "./entityResolution.js";
import type { IntrospectResponse } from "./contract.js";

function schema(entities: IntrospectResponse["entities"]): IntrospectResponse {
  return { entities };
}

describe("resolveSourceEntity", () => {
  it("resolves the unique entity whose fields are a superset of the mapping's from-fields", () => {
    const result = resolveSourceEntity(
      schema([
        { namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }, { name: "total", type: "int" }] },
        { namespace: "public", name: "customers", fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }] },
      ]),
      ["total", "id"],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.name).toBe("orders");
  });

  it("fails closed with reason 'no-match' when no entity has all the mapped fields", () => {
    const result = resolveSourceEntity(
      schema([{ namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }] }]),
      ["id", "nonexistent_field"],
    );
    expect(result).toEqual({ ok: false, reason: "no-match", message: "Mapping fields match no single table." });
  });

  it("fails closed with reason 'ambiguous' and names every candidate when multiple entities match", () => {
    const result = resolveSourceEntity(
      schema([
        { namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }] },
        { namespace: "public", name: "customers", fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }] },
      ]),
      ["id", "name"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "ambiguous") {
      expect(result.message).toBe("Mapping fields match 2 tables: public.orders, public.customers");
      expect(result.candidates).toEqual(["public.orders", "public.customers"]);
    } else {
      throw new Error("expected ambiguous result");
    }
  });

  it("never guesses among ambiguous candidates even when field sets are identical", () => {
    const result = resolveSourceEntity(
      schema([
        { namespace: "a", name: "t1", fields: [{ name: "x", type: "int" }] },
        { namespace: "b", name: "t2", fields: [{ name: "x", type: "int" }] },
      ]),
      ["x"],
    );
    expect(result.ok).toBe(false);
  });

  it("fails closed with reason 'no-fields' when the mapping has no from-field entries", () => {
    const result = resolveSourceEntity(
      schema([{ namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }] }]),
      [],
    );
    expect(result).toEqual({
      ok: false,
      reason: "no-fields",
      message: "Mapping has no field entries to infer a source table from.",
    });
  });

  it("ignores empty-string field entries (mid-edit autosave transients)", () => {
    const result = resolveSourceEntity(
      schema([{ namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }] }]),
      ["id", ""],
    );
    expect(result.ok).toBe(true);
  });

  it("deduplicates repeated from-field entries without affecting matching", () => {
    const result = resolveSourceEntity(
      schema([{ namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }] }]),
      ["id", "id"],
    );
    expect(result.ok).toBe(true);
  });
});

describe("findPersistedEntity", () => {
  const TWO_TABLES = schema([
    { namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }] },
    { namespace: "public", name: "customers", fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }] },
  ]);

  it("finds the entity matching namespace+name", () => {
    const result = findPersistedEntity(TWO_TABLES, { namespace: "public", name: "customers" });
    expect(result?.name).toBe("customers");
  });

  it("returns undefined when the ref no longer resolves (renamed/dropped upstream)", () => {
    const result = findPersistedEntity(TWO_TABLES, { namespace: "public", name: "deleted_table" });
    expect(result).toBeUndefined();
  });

  it("is namespace-sensitive — a name match in the wrong namespace doesn't resolve", () => {
    const result = findPersistedEntity(TWO_TABLES, { namespace: "other_schema", name: "customers" });
    expect(result).toBeUndefined();
  });
});

describe("fieldNamesForSource", () => {
  const TWO_TABLES = schema([
    { namespace: "public", name: "orders", fields: [{ name: "id", type: "int" }, { name: "total", type: "int" }] },
    { namespace: "public", name: "customers", fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }] },
  ]);

  it("scopes strictly to the persisted entity's fields when it resolves", () => {
    const result = fieldNamesForSource(TWO_TABLES, { namespace: "public", name: "customers" });
    expect(result.sort()).toEqual(["id", "name"]);
  });

  it("falls back to the flat deduplicated union when no entity is given (pre-Block-0 behavior)", () => {
    const result = fieldNamesForSource(TWO_TABLES);
    expect(result.sort()).toEqual(["id", "name", "total"]);
  });

  it("falls back to the flat union when the persisted entity has drifted (no longer resolves)", () => {
    const result = fieldNamesForSource(TWO_TABLES, { namespace: "public", name: "deleted_table" });
    expect(result.sort()).toEqual(["id", "name", "total"]);
  });

  it("Phase 6 Block 1: logs a warning when it takes the flat-union fallback, both no-entity and drifted-entity cases", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fieldNamesForSource(TWO_TABLES);
    fieldNamesForSource(TWO_TABLES, { namespace: "public", name: "deleted_table" });
    fieldNamesForSource(TWO_TABLES, { namespace: "public", name: "customers" });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("no persisted entity");
    expect(warn.mock.calls[1]![0]).toContain("deleted_table");
    warn.mockRestore();
  });
});
