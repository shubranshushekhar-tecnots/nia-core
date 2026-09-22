import { describe, it, expect } from "vitest";
import {
  MYSQL_ADAPTER,
  POSTGRES_ADAPTER,
  MONGO_ADAPTER,
  schemaFromIntrospection,
  type DialectAdapter,
  type Fidelity,
} from "./niaAdapters.js";
import type { NiaType } from "./niaType.js";

function expectLossless(f: Fidelity) {
  expect(f.kind).toBe("lossless");
}
function expectLossy(f: Fidelity) {
  expect(f.kind).toBe("lossy");
  if (f.kind === "lossy") expect(f.reason.length).toBeGreaterThan(0);
}

describe("MYSQL_ADAPTER", () => {
  const toCases: Array<[string, NiaType, "lossless" | "lossy"]> = [
    ["tinyint", { kind: "integer" }, "lossless"],
    ["smallint", { kind: "integer" }, "lossless"],
    ["mediumint", { kind: "integer" }, "lossless"],
    ["int", { kind: "integer" }, "lossless"],
    ["bigint", { kind: "integer" }, "lossless"],
    ["decimal", { kind: "decimal" }, "lossless"],
    ["numeric", { kind: "decimal" }, "lossless"],
    ["float", { kind: "float" }, "lossless"],
    ["double", { kind: "float" }, "lossless"],
    ["char", { kind: "string" }, "lossless"],
    ["varchar", { kind: "string" }, "lossless"],
    ["text", { kind: "string" }, "lossless"],
    ["mediumtext", { kind: "string" }, "lossless"],
    ["longtext", { kind: "string" }, "lossless"],
    ["date", { kind: "date" }, "lossless"],
    ["datetime", { kind: "timestamp", tz: "naive" }, "lossless"],
    ["timestamp", { kind: "timestamp", tz: "utc" }, "lossless"],
    ["time", { kind: "string" }, "lossy"],
    ["year", { kind: "integer" }, "lossy"],
    ["json", { kind: "json" }, "lossless"],
    ["binary", { kind: "bytes" }, "lossless"],
    ["varbinary", { kind: "bytes" }, "lossless"],
    ["blob", { kind: "bytes" }, "lossless"],
    ["bit", { kind: "bytes" }, "lossy"],
    ["enum", { kind: "string" }, "lossy"],
    ["set", { kind: "string" }, "lossy"],
    ["geometry", { kind: "json" }, "lossy"],
  ];

  it.each(toCases)("toNiaType(%s)", (native, expectedType, expectedFidelity) => {
    const { type, fidelity } = MYSQL_ADAPTER.toNiaType(native);
    expect(type).toEqual(expectedType);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });

  it("toNiaType is case-insensitive", () => {
    expect(MYSQL_ADAPTER.toNiaType("INT").type).toEqual({ kind: "integer" });
  });

  const fromCases: Array<[NiaType, string, "lossless" | "lossy"]> = [
    [{ kind: "string" }, "VARCHAR(255)", "lossless"],
    [{ kind: "string", format: "uuid" }, "CHAR(36)", "lossless"],
    [{ kind: "string", format: "objectId" }, "VARCHAR(24)", "lossless"],
    [{ kind: "integer" }, "BIGINT", "lossless"],
    [{ kind: "float" }, "DOUBLE", "lossless"],
    [{ kind: "decimal", precision: 10, scale: 2 }, "DECIMAL(10,2)", "lossless"],
    [{ kind: "decimal" }, "DOUBLE", "lossy"],
    [{ kind: "boolean" }, "TINYINT(1)", "lossless"],
    [{ kind: "date" }, "DATE", "lossless"],
    [{ kind: "timestamp", tz: "utc" }, "TIMESTAMP", "lossless"],
    [{ kind: "timestamp", tz: "naive" }, "DATETIME", "lossless"],
    [{ kind: "bytes" }, "BLOB", "lossless"],
    [{ kind: "json" }, "JSON", "lossless"],
    [{ kind: "object", fields: {} }, "JSON", "lossy"],
    [{ kind: "array", element: { kind: "string" } }, "JSON", "lossy"],
  ];

  it.each(fromCases)("fromNiaType(%j)", (type, expectedNative, expectedFidelity) => {
    const { nativeType, fidelity } = MYSQL_ADAPTER.fromNiaType(type);
    expect(nativeType).toBe(expectedNative);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });
});

describe("POSTGRES_ADAPTER", () => {
  const toCases: Array<[string, NiaType, "lossless" | "lossy"]> = [
    ["smallint", { kind: "integer" }, "lossless"],
    ["integer", { kind: "integer" }, "lossless"],
    ["bigint", { kind: "integer" }, "lossless"],
    ["numeric", { kind: "decimal" }, "lossy"],
    ["decimal", { kind: "decimal" }, "lossy"],
    ["real", { kind: "float" }, "lossless"],
    ["double precision", { kind: "float" }, "lossless"],
    ["character varying", { kind: "string" }, "lossless"],
    ["character", { kind: "string" }, "lossless"],
    ["text", { kind: "string" }, "lossless"],
    ["boolean", { kind: "boolean" }, "lossless"],
    ["date", { kind: "date" }, "lossless"],
    ["timestamp without time zone", { kind: "timestamp", tz: "naive" }, "lossless"],
    ["timestamp with time zone", { kind: "timestamp", tz: "utc" }, "lossless"],
    ["time without time zone", { kind: "string" }, "lossy"],
    ["time with time zone", { kind: "string" }, "lossy"],
    ["uuid", { kind: "string", format: "uuid" }, "lossless"],
    ["json", { kind: "json" }, "lossless"],
    ["jsonb", { kind: "json" }, "lossless"],
    ["bytea", { kind: "bytes" }, "lossless"],
    ["ARRAY", { kind: "json" }, "lossy"],
    ["USER-DEFINED", { kind: "string" }, "lossy"],
    ["box", { kind: "json" }, "lossy"],
  ];

  it.each(toCases)("toNiaType(%s)", (native, expectedType, expectedFidelity) => {
    const { type, fidelity } = POSTGRES_ADAPTER.toNiaType(native);
    expect(type).toEqual(expectedType);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });

  const fromCases: Array<[NiaType, string, "lossless" | "lossy"]> = [
    [{ kind: "string" }, "TEXT", "lossless"],
    [{ kind: "string", format: "uuid" }, "UUID", "lossless"],
    [{ kind: "string", format: "objectId" }, "TEXT", "lossy"],
    [{ kind: "integer" }, "BIGINT", "lossless"],
    [{ kind: "float" }, "DOUBLE PRECISION", "lossless"],
    [{ kind: "decimal", precision: 10, scale: 2 }, "NUMERIC(10,2)", "lossless"],
    [{ kind: "decimal" }, "NUMERIC", "lossless"],
    [{ kind: "boolean" }, "BOOLEAN", "lossless"],
    [{ kind: "date" }, "DATE", "lossless"],
    [{ kind: "timestamp", tz: "utc" }, "TIMESTAMPTZ", "lossless"],
    [{ kind: "timestamp", tz: "naive" }, "TIMESTAMP", "lossless"],
    [{ kind: "bytes" }, "BYTEA", "lossless"],
    [{ kind: "json" }, "JSONB", "lossless"],
    [{ kind: "object", fields: {} }, "JSONB", "lossy"],
    [{ kind: "array", element: { kind: "integer" } }, "JSONB", "lossy"],
  ];

  it.each(fromCases)("fromNiaType(%j)", (type, expectedNative, expectedFidelity) => {
    const { nativeType, fidelity } = POSTGRES_ADAPTER.fromNiaType(type);
    expect(nativeType).toBe(expectedNative);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });
});

describe("MONGO_ADAPTER", () => {
  const toCases: Array<[string, NiaType, "lossless" | "lossy"]> = [
    ["string", { kind: "string" }, "lossless"],
    ["number", { kind: "float" }, "lossless"],
    ["boolean", { kind: "boolean" }, "lossless"],
    ["date", { kind: "timestamp", tz: "utc" }, "lossless"],
    ["json", { kind: "json" }, "lossless"],
    ["binary", { kind: "bytes" }, "lossless"],
    ["unknown", { kind: "json" }, "lossy"],
    ["bogus", { kind: "json" }, "lossy"],
  ];

  it.each(toCases)("toNiaType(%s)", (native, expectedType, expectedFidelity) => {
    const { type, fidelity } = MONGO_ADAPTER.toNiaType(native);
    expect(type).toEqual(expectedType);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });

  const fromCases: Array<[NiaType, string, "lossless" | "lossy"]> = [
    [{ kind: "string" }, "string", "lossless"],
    [{ kind: "integer" }, "long", "lossless"],
    [{ kind: "float" }, "double", "lossless"],
    [{ kind: "decimal", precision: 10, scale: 2 }, "decimal128", "lossless"],
    [{ kind: "decimal" }, "double", "lossy"],
    [{ kind: "boolean" }, "boolean", "lossless"],
    [{ kind: "date" }, "date", "lossless"],
    [{ kind: "timestamp", tz: "utc" }, "date", "lossless"],
    [{ kind: "timestamp", tz: "naive" }, "date", "lossy"],
    [{ kind: "bytes" }, "binData", "lossless"],
    [{ kind: "json" }, "object", "lossy"],
    [{ kind: "object", fields: {} }, "object", "lossless"],
    [{ kind: "array", element: { kind: "string" } }, "array", "lossless"],
  ];

  it.each(fromCases)("fromNiaType(%j)", (type, expectedNative, expectedFidelity) => {
    const { nativeType, fidelity } = MONGO_ADAPTER.fromNiaType(type);
    expect(nativeType).toBe(expectedNative);
    expectedFidelity === "lossless" ? expectLossless(fidelity) : expectLossy(fidelity);
  });
});

describe("every DialectAdapter's fromNiaType covers every NiaTypeKind", () => {
  const sampleByKind: Record<NiaType["kind"], NiaType> = {
    string: { kind: "string" },
    integer: { kind: "integer" },
    float: { kind: "float" },
    decimal: { kind: "decimal", precision: 10, scale: 2 },
    boolean: { kind: "boolean" },
    date: { kind: "date" },
    timestamp: { kind: "timestamp", tz: "utc" },
    bytes: { kind: "bytes" },
    json: { kind: "json" },
    object: { kind: "object", fields: {} },
    array: { kind: "array", element: { kind: "string" } },
  };

  const adapters: DialectAdapter[] = [MYSQL_ADAPTER, POSTGRES_ADAPTER, MONGO_ADAPTER];

  it.each(adapters.map((a) => [a.dialect, a] as const))("%s", (_dialect, adapter) => {
    for (const kind of Object.keys(sampleByKind) as NiaType["kind"][]) {
      const { nativeType, fidelity } = adapter.fromNiaType(sampleByKind[kind]);
      expect(typeof nativeType).toBe("string");
      expect(nativeType.length).toBeGreaterThan(0);
      expect(["lossless", "lossy"]).toContain(fidelity.kind);
    }
  });
});

describe("schemaFromIntrospection", () => {
  it("converts a declared mysql entity to a NiaSchema, nullable: true, no presence", () => {
    const entity = {
      fields: [
        { name: "id", type: "bigint" },
        { name: "name", type: "varchar" },
        { name: "payload", type: "json" },
      ],
    };
    const { schema, fidelity } = schemaFromIntrospection(entity, "mysql");
    expect(schema.fields.id).toEqual({ type: { kind: "integer" }, nullable: true });
    expect(schema.fields.name).toEqual({ type: { kind: "string" }, nullable: true });
    expect(schema.fields.payload).toEqual({ type: { kind: "json" }, nullable: true });
    expect(schema.fields.id!.presence).toBeUndefined();
    expect(fidelity.id).toEqual({ kind: "lossless" });
  });

  it("converts a declared postgres entity, surfacing lossy fidelity for numeric", () => {
    const entity = { fields: [{ name: "amount", type: "numeric" }] };
    const { schema, fidelity } = schemaFromIntrospection(entity, "postgres");
    expect(schema.fields.amount!.type).toEqual({ kind: "decimal" });
    expect(fidelity.amount!.kind).toBe("lossy");
  });

  it("converts a declared mongo entity from ColumnType strings", () => {
    const entity = { fields: [{ name: "created_at", type: "date" }] };
    const { schema } = schemaFromIntrospection(entity, "mongo");
    expect(schema.fields.created_at!.type).toEqual({ kind: "timestamp", tz: "utc" });
  });
});
