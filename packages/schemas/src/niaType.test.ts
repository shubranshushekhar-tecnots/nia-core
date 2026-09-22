import { describe, it, expect } from "vitest";
import { join, joinField, type NiaType, type NiaField } from "./niaType.js";

const t = (kind: NiaType["kind"], extra: Partial<NiaType> = {}): NiaType => ({ kind, ...extra }) as NiaType;

describe("join", () => {
  it("same-kind scalars merge losslessly", () => {
    for (const kind of ["boolean", "bytes", "json", "date"] as const) {
      const result = join(t(kind), t(kind));
      expect(result).toEqual({ type: { kind }, degraded: false, reason: null });
    }
  });

  it("integer ⊔ float = float", () => {
    const result = join(t("integer"), t("float"));
    expect(result).toEqual({ type: { kind: "float" }, degraded: false, reason: null });
  });

  it("integer ⊔ decimal = decimal", () => {
    const decimal: NiaType = { kind: "decimal", precision: 10, scale: 2 };
    const result = join(t("integer"), decimal);
    expect(result.degraded).toBe(false);
    expect(result.type).toEqual(decimal);
  });

  it("float ⊔ decimal = decimal", () => {
    const decimal: NiaType = { kind: "decimal", precision: 10, scale: 2 };
    const result = join(t("float"), decimal);
    expect(result.degraded).toBe(false);
    expect(result.type).toEqual(decimal);
  });

  it("decimal ⊔ decimal keeps matching precision/scale, drops mismatched", () => {
    const same = join({ kind: "decimal", precision: 10, scale: 2 }, { kind: "decimal", precision: 10, scale: 2 });
    expect(same).toEqual({ type: { kind: "decimal", precision: 10, scale: 2 }, degraded: false, reason: null });

    const diff = join({ kind: "decimal", precision: 10, scale: 2 }, { kind: "decimal", precision: 5, scale: 2 });
    expect(diff).toEqual({ type: { kind: "decimal", precision: undefined, scale: 2 }, degraded: false, reason: null });
  });

  it("date ⊔ timestamp = timestamp, inheriting the timestamp side's tz", () => {
    const ts: NiaType = { kind: "timestamp", tz: "utc" };
    expect(join(t("date"), ts)).toEqual({ type: ts, degraded: false, reason: null });
    expect(join(ts, t("date"))).toEqual({ type: ts, degraded: false, reason: null });
  });

  it("timestamp ⊔ timestamp keeps matching tz, falls to naive on mismatch", () => {
    const utc: NiaType = { kind: "timestamp", tz: "utc" };
    const naive: NiaType = { kind: "timestamp", tz: "naive" };
    expect(join(utc, utc)).toEqual({ type: utc, degraded: false, reason: null });
    expect(join(utc, naive)).toEqual({ type: naive, degraded: false, reason: null });
  });

  it("string ⊔ string keeps a matching format, drops a conflicting one", () => {
    const uuid: NiaType = { kind: "string", format: "uuid" };
    expect(join(uuid, uuid)).toEqual({ type: uuid, degraded: false, reason: null });

    const objectId: NiaType = { kind: "string", format: "objectId" };
    const result = join(uuid, objectId);
    expect(result.degraded).toBe(false);
    expect(result.type).toEqual({ kind: "string", format: undefined });
  });

  it("object ⊔ object merges fields, marking exclusive keys nullable", () => {
    const a: NiaType = {
      kind: "object",
      fields: {
        name: { type: { kind: "string" }, nullable: false },
        age: { type: { kind: "integer" }, nullable: false },
      },
    };
    const b: NiaType = {
      kind: "object",
      fields: {
        name: { type: { kind: "string" }, nullable: true },
        email: { type: { kind: "string" }, nullable: false },
      },
    };
    const result = join(a, b);
    expect(result.degraded).toBe(false);
    expect(result.type).toEqual({
      kind: "object",
      fields: {
        name: { type: { kind: "string", format: undefined }, nullable: true },
        age: { type: { kind: "integer" }, nullable: true },
        email: { type: { kind: "string" }, nullable: true },
      },
    });
  });

  it("object ⊔ object propagates a degraded field's clash up to the object join", () => {
    const a: NiaType = { kind: "object", fields: { id: { type: { kind: "integer" }, nullable: false } } };
    const b: NiaType = { kind: "object", fields: { id: { type: { kind: "string" }, nullable: false } } };
    const result = join(a, b);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('"id"');
    expect((result.type as { kind: "object"; fields: Record<string, NiaField> }).fields.id!.type).toEqual({ kind: "string" });
  });

  it("array<A> ⊔ array<B> = array<A ⊔ B>, propagating degraded-ness from the element join", () => {
    const clean = join({ kind: "array", element: t("integer") }, { kind: "array", element: t("float") });
    expect(clean).toEqual({ type: { kind: "array", element: { kind: "float" } }, degraded: false, reason: null });

    const dirty = join({ kind: "array", element: t("integer") }, { kind: "array", element: t("string") });
    expect(dirty.degraded).toBe(true);
    expect(dirty.type).toEqual({ kind: "array", element: { kind: "string" } });
  });

  it("falls back to string on an incompatible scalar clash", () => {
    const result = join(t("integer"), t("string"));
    expect(result.degraded).toBe(true);
    expect(result.type).toEqual({ kind: "string" });
    expect(result.reason).toBeTruthy();
  });

  it("falls back to json when a structural type clashes with a scalar", () => {
    const objType: NiaType = { kind: "object", fields: {} };
    const result = join(objType, t("integer"));
    expect(result.degraded).toBe(true);
    expect(result.type).toEqual({ kind: "json" });
  });

  it("falls back to json when object and array clash (both structural, neither ladder applies)", () => {
    const result = join({ kind: "object", fields: {} }, { kind: "array", element: t("string") });
    expect(result.degraded).toBe(true);
    expect(result.type).toEqual({ kind: "json" });
  });

  it("json ⊔ json stays json, losslessly", () => {
    expect(join(t("json"), t("json"))).toEqual({ type: { kind: "json" }, degraded: false, reason: null });
  });
});

describe("joinField", () => {
  it("anything ⊔ null = nullable, same type, not degraded", () => {
    const field: NiaField = { type: { kind: "integer" }, nullable: false, presence: 1 };
    const result = joinField(field, null);
    expect(result.degraded).toBe(false);
    expect(result.field).toEqual({ type: { kind: "integer" }, nullable: true, presence: 1 });
  });

  it("joins two present fields, OR-ing nullable and joining their types", () => {
    const a: NiaField = { type: { kind: "integer" }, nullable: false };
    const b: NiaField = { type: { kind: "float" }, nullable: true };
    const result = joinField(a, b);
    expect(result.degraded).toBe(false);
    expect(result.field.type).toEqual({ kind: "float" });
    expect(result.field.nullable).toBe(true);
  });
});
