import { describe, it, expect } from "vitest";
import { flattenOp } from "./flatten.js";
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
  it("quarantines (does not throw or silently NULL) a row whose value isn't an object despite an object-typed schema — Schema layer Part 5 routes this through the same quarantine reporting as any other fallible row, not a run-abort", () => {
    const input = { cols: ["profile"], rows: [{ profile: "not-an-object" }] };
    const result = flattenOp.applyResidual(input, step("profile"));
    expect(result.rows).toEqual([]);
    expect(result.failures).toEqual([
      {
        label: 'flatten "profile"',
        fns: ["flatten_non_object"],
        policy: "quarantine",
        count: 1,
        quarantinedRows: [{ fn: "flatten_non_object", inputValue: "not-an-object", sourceRow: { profile: "not-an-object" } }],
      },
    ]);
  });

  it("keeps a passing row and quarantines only the failing one, naming the field in the failure report's label", () => {
    const input = { cols: ["profile"], rows: [{ profile: { name: "ok" } }, { profile: "not an object" }] };
    const result = flattenOp.applyResidual(input, step("profile"));
    expect(result.rows).toEqual([{ profile_name: "ok" }]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0]!.label).toBe('flatten "profile"');
    expect(result.failures![0]!.count).toBe(1);
    expect(result.failures![0]!.quarantinedRows![0]!.sourceRow).toEqual({ profile: "not an object" });
  });

  it("treats null as a legitimate absent value, not a throw", () => {
    const input = { cols: ["profile"], rows: [{ profile: null }] };
    const result = flattenOp.applyResidual(input, step("profile"));
    expect(result.rows).toEqual([{}]);
  });
});
