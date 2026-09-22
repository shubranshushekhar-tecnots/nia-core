import { describe, it, expect } from "vitest";
import { inferSchemaFromColumns, normalizeFieldName } from "./niaInference.js";
import type { ColumnStats } from "./profile.js";

function col(name: string, observedTypeCounts: Record<string, number>, overrides: Partial<ColumnStats> = {}): ColumnStats {
  const sampleCount = overrides.sampleCount ?? Object.values(observedTypeCounts).reduce((a, b) => a + b, 0);
  return {
    name,
    declaredType: "unknown",
    observedTypes: Object.keys(observedTypeCounts),
    observedTypeCounts,
    sampleCount,
    nullCount: observedTypeCounts.null ?? 0,
    emptyStringCount: 0,
    whitespaceOnlyCount: 0,
    distinctCount: sampleCount,
    missingTokenCount: 0,
    isTextColumn: false,
    parseRates: null,
    min: null,
    max: null,
    minLength: null,
    maxLength: null,
    hasLeadingZeroStrings: false,
    ...overrides,
  };
}

describe("inferSchemaFromColumns", () => {
  it("infers a nested object from dotted-path columns", () => {
    const schema = inferSchemaFromColumns([
      col("user.name", { string: 10 }),
      col("user.age", { integer: 10 }),
      col("id", { string: 10 }),
    ]);

    expect(schema.fields.id).toEqual({ type: { kind: "string" }, nullable: false, presence: 1 });
    expect(schema.fields.user!.type.kind).toBe("object");
    if (schema.fields.user!.type.kind === "object") {
      expect(schema.fields.user!.type.fields.name).toEqual({ type: { kind: "string" }, nullable: false, presence: 1 });
      expect(schema.fields.user!.type.fields.age).toEqual({ type: { kind: "integer" }, nullable: false, presence: 1 });
    }
  });

  it("infers an array field (connector-mongodb stringifies arrays to a single json-shaped column, not a nested path)", () => {
    const schema = inferSchemaFromColumns([col("tags", { json: 10 })]);
    expect(schema.fields.tags).toEqual({ type: { kind: "json" }, nullable: false, presence: 1 });
  });

  it("joins a mixed-type field's observed shapes (integer + float -> float)", () => {
    const schema = inferSchemaFromColumns([col("amount", { integer: 6, float: 4 })]);
    expect(schema.fields.amount!.type).toEqual({ kind: "float" });
    expect(schema.fields.amount!.nullable).toBe(false);
  });

  it("marks a field present in only some documents (partial presence) as nullable with presence < 1", () => {
    const schema = inferSchemaFromColumns([col("nickname", { string: 3, null: 7 }, { sampleCount: 10 })]);
    expect(schema.fields.nickname!.nullable).toBe(true);
    expect(schema.fields.nickname!.presence).toBeCloseTo(0.3);
  });

  it("a nested object present in only some documents propagates nullable/presence from its least-present child", () => {
    const schema = inferSchemaFromColumns([
      col("addr.city", { string: 4, null: 6 }, { sampleCount: 10 }),
      col("addr.zip", { string: 8, null: 2 }, { sampleCount: 10 }),
    ]);
    expect(schema.fields.addr!.nullable).toBe(true);
    expect(schema.fields.addr!.presence).toBeCloseTo(0.4);
  });

  it("degrades a path that is both a scalar leaf and an object prefix to json", () => {
    const schema = inferSchemaFromColumns([col("a", { string: 5 }), col("a.b", { integer: 5 })]);
    expect(schema.fields.a!.type.kind).toBe("json");
  });

  it("a field with only null samples falls back to a nullable json field", () => {
    const schema = inferSchemaFromColumns([col("mystery", { null: 5 }, { sampleCount: 5 })]);
    expect(schema.fields.mystery).toEqual({ type: { kind: "json" }, nullable: true, presence: 0 });
  });
});

describe("normalizeFieldName", () => {
  it("lowercases and replaces disallowed characters", () => {
    const seen = new Set<string>();
    expect(normalizeFieldName("User Name!", seen)).toBe("user_name");
  });

  it("resolves a collision with a numeric suffix", () => {
    const seen = new Set<string>();
    const first = normalizeFieldName("User Name", seen);
    const second = normalizeFieldName("user_name", seen);
    const third = normalizeFieldName("USER_NAME", seen);
    expect(first).toBe("user_name");
    expect(second).toBe("user_name_2");
    expect(third).toBe("user_name_3");
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("truncates an over-length name with a hash suffix, still avoiding collisions", () => {
    const seen = new Set<string>();
    const long = "a".repeat(100);
    const normalized = normalizeFieldName(long, seen, { maxLength: 20 });
    expect(normalized.length).toBeLessThanOrEqual(20);
    expect(normalized.startsWith("a")).toBe(true);
  });
});
