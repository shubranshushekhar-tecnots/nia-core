import { describe, it, expect } from "vitest";
import { flattenOp } from "./flatten.js";
import { ResidualAbortError } from "./onFailure.js";
import type { FlattenStep } from "../nodeConfig.js";
import type { NiaSchema } from "../niaType.js";

const step = (field: string, maxDepth = 1): FlattenStep => ({ kind: "flatten", field, maxDepth });

describe("flattenOp.outputSchema", () => {
  it("fails naming the column on a non-object source field — never guesses", () => {
    const input: NiaSchema = { fields: { tags: { type: { kind: "string" }, nullable: false } } };
    const result = flattenOp.outputSchema(input, step("tags"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tags");
  });

  it("fails naming the column when a flattened child name collides with an existing sibling column", () => {
    const input: NiaSchema = {
      fields: {
        profile: {
          type: { kind: "object", fields: { name: { type: { kind: "string" }, nullable: false } } },
          nullable: false,
        },
        profile_name: { type: { kind: "string" }, nullable: false },
      },
    };
    const result = flattenOp.outputSchema(input, step("profile"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("profile_name");
  });

  it("flattens an object field into prefixed columns on success", () => {
    const input: NiaSchema = {
      fields: {
        profile: {
          type: { kind: "object", fields: { name: { type: { kind: "string" }, nullable: false } } },
          nullable: false,
        },
      },
    };
    const result = flattenOp.outputSchema(input, step("profile"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schema.fields.profile_name).toEqual({ type: { kind: "string" }, nullable: false });
      expect(result.schema.fields.profile).toBeUndefined();
    }
  });
});

describe("flattenOp.applyResidual", () => {
  it("throws a ResidualAbortError (does not silently NULL) when a row's value isn't an object despite an object-typed schema — routed by runEtl.ts to a clean run-abort, not an uncaught exception", () => {
    const input = { cols: ["profile"], rows: [{ profile: "not-an-object" }] };
    expect(() => flattenOp.applyResidual(input, step("profile"))).toThrow(ResidualAbortError);
    expect(() => flattenOp.applyResidual(input, step("profile"))).toThrow(/not an object/);
  });

  it("names both the field and the failing row's index in the thrown message", () => {
    const input = { cols: ["profile"], rows: [{ profile: { name: "ok" } }, { profile: "not an object" }] };
    expect(() => flattenOp.applyResidual(input, step("profile"))).toThrow(/"profile"/);
    expect(() => flattenOp.applyResidual(input, step("profile"))).toThrow(/row index 1/);
  });

  it("treats null as a legitimate absent value, not a throw", () => {
    const input = { cols: ["profile"], rows: [{ profile: null }] };
    const result = flattenOp.applyResidual(input, step("profile"));
    expect(result.rows).toEqual([{}]);
  });
});
