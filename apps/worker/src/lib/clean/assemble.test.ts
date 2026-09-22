import { describe, expect, it } from "vitest";
import { buildAssembledPlan } from "./assemble.js";
import type { ColumnStepProposal, SpecialistResult } from "./specialistTypes.js";

/**
 * Phase 13, Step 5 — covers the plan's required unit test coverage for
 * assemble/dry-run: merge ordering (missing-value before coercion),
 * per-step dry-run before/after + failure counts, the >50% coercion
 * failure-rate drop guard, maxFailureRate = max(2 * rate, 1%), and
 * per-step provenance stamping.
 */

const notesMissingValueProposal: ColumnStepProposal = {
  column: "notes",
  kind: "step",
  rationale: "normalize 'n/a' tokens to null",
  step: {
    kind: "computed_field",
    name: "notes",
    expression: {
      kind: "conditional",
      branches: [
        {
          when: {
            kind: "comparison",
            op: "eq",
            left: { kind: "call", fn: "lower", args: [{ kind: "call", fn: "trim", args: [{ kind: "field", name: "notes" }] }] },
            right: { kind: "literal", value: "n/a" },
          },
          then: { kind: "literal", value: null },
        },
      ],
      else: { kind: "field", name: "notes" },
    },
    onFailure: "null",
  },
};

const amountCoercionProposal: ColumnStepProposal = {
  column: "amount",
  kind: "step",
  rationale: "strip $ and , then coerce to a number",
  step: {
    kind: "computed_field",
    name: "amount",
    expression: {
      kind: "call",
      fn: "to_number",
      args: [{ kind: "call", fn: "regex_replace", args: [{ kind: "field", name: "amount" }, { kind: "literal", value: "[$,]" }, { kind: "literal", value: "" }] }],
    },
    onFailure: "quarantine",
  },
};

/** A deliberately bad coercion proposal: to_number() applied directly to mostly non-numeric text — fails on 2 of 3 sample rows (66.7%), over the 50% guard. */
const codeCoercionProposalOverGuard: ColumnStepProposal = {
  column: "code",
  kind: "step",
  rationale: "coerce code to a number",
  step: {
    kind: "computed_field",
    name: "code",
    expression: { kind: "call", fn: "to_number", args: [{ kind: "field", name: "code" }] },
    onFailure: "quarantine",
  },
};

function missingValueResult(proposals: SpecialistResult["proposals"]): SpecialistResult {
  return { specialist: "missing-value", onFailure: "null", proposals };
}

function coercionResult(proposals: SpecialistResult["proposals"]): SpecialistResult {
  return { specialist: "coercion", onFailure: "quarantine", proposals };
}

describe("buildAssembledPlan", () => {
  it("orders missing-value steps before coercion steps and dry-runs each against the sample", () => {
    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-1",
      model: "test-model",
      baseGraphVersion: 3,
      existingStepCount: 2,
      sampleColumns: ["notes", "amount"],
      sampleRows: [
        ["N/A", "$10.00"],
        ["n/a", "$25.50"],
        ["Hello world", "$3.75"],
      ],
      missingValue: missingValueResult([notesMissingValueProposal]),
      coercion: coercionResult([amountCoercionProposal]),
    });

    expect(result.stepReports.map((r) => r.column)).toEqual(["notes", "amount"]);
    expect(result.stepReports.every((r) => r.included)).toBe(true);

    const notesReport = result.stepReports[0]!;
    expect(notesReport.before).toEqual(["N/A", "n/a", "Hello world"]);
    expect(notesReport.after).toEqual([null, null, "Hello world"]);
    expect(notesReport.failureCount).toBe(0);
    expect(notesReport.sampleSize).toBe(3);

    const amountReport = result.stepReports[1]!;
    expect(amountReport.before).toEqual(["$10.00", "$25.50", "$3.75"]);
    expect(amountReport.after).toEqual([10, 25.5, 3.75]);
    expect(amountReport.failureCount).toBe(0);

    expect(result.diff.baseGraphVersion).toBe(3);
    expect(result.diff.ops).toHaveLength(2);
    expect(result.diff.ops[0]).toMatchObject({ kind: "addStep", nodeId: "node-1", index: 2 });
    expect(result.diff.ops[1]).toMatchObject({ kind: "addStep", nodeId: "node-1", index: 3 });
  });

  it("stamps per-step provenance with each step's own specialist name", () => {
    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-42",
      model: "test-model",
      baseGraphVersion: 0,
      existingStepCount: 0,
      sampleColumns: ["notes", "amount"],
      sampleRows: [["N/A", "$10.00"]],
      missingValue: missingValueResult([notesMissingValueProposal]),
      coercion: coercionResult([amountCoercionProposal]),
    });

    const notesOp = result.diff.ops[0]!;
    const amountOp = result.diff.ops[1]!;
    expect(notesOp.kind === "addStep" ? notesOp.step.provenance : undefined).toEqual({
      source: "specialist",
      planId: "plan-42",
      specialist: "missing-value",
      model: "test-model",
    });
    expect(amountOp.kind === "addStep" ? amountOp.step.provenance : undefined).toEqual({
      source: "specialist",
      planId: "plan-42",
      specialist: "coercion",
      model: "test-model",
    });
  });

  it("drops a coercion step whose dry-run failure rate exceeds 50% and reports it, without adding it to the diff", () => {
    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-1",
      baseGraphVersion: 0,
      existingStepCount: 0,
      sampleColumns: ["code"],
      sampleRows: [["ABC"], ["XYZ"], ["123"]],
      missingValue: missingValueResult([]),
      coercion: coercionResult([codeCoercionProposalOverGuard]),
    });

    expect(result.diff.ops).toHaveLength(0);
    expect(result.stepReports).toHaveLength(1);
    const report = result.stepReports[0]!;
    expect(report.included).toBe(false);
    expect(report.failureCount).toBe(2);
    expect(report.failureRate).toBeCloseTo(2 / 3);
    expect(report.after).toEqual(report.before);
    expect(report.dropReason).toContain("exceeds the 50% guard");

    expect(result.skippedProposals).toContainEqual(
      expect.objectContaining({ column: "code", specialist: "coercion", reason: expect.stringContaining("50% guard") }),
    );
  });

  it("computes maxFailureRate as max(2 * failureRate, 1%)", () => {
    // A missing-value step is never dropped by the coercion guard, so use one
    // whose expression fails on a known fraction of rows to check the formula
    // directly, independent of the drop threshold.
    const halfFailingProposal: ColumnStepProposal = {
      column: "code",
      kind: "step",
      rationale: "coerce code to a number",
      step: {
        kind: "computed_field",
        name: "code",
        expression: { kind: "call", fn: "to_number", args: [{ kind: "field", name: "code" }] },
        onFailure: "quarantine",
      },
    };

    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-1",
      baseGraphVersion: 0,
      existingStepCount: 0,
      // 1-of-4 fails (25%) — under the 50% guard, so it stays included, and
      // 2 * 0.25 = 0.5 is well above the 1% floor.
      sampleColumns: ["code"],
      sampleRows: [["1"], ["2"], ["3"], ["ABC"]],
      missingValue: missingValueResult([{ ...halfFailingProposal, column: "code" }]),
      coercion: coercionResult([]),
    });

    const report = result.stepReports[0]!;
    expect(report.failureRate).toBeCloseTo(0.25);
    expect(report.maxFailureRate).toBeCloseTo(0.5);
  });

  it("floors maxFailureRate at 1% when the dry-run failure rate is 0", () => {
    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-1",
      baseGraphVersion: 0,
      existingStepCount: 0,
      sampleColumns: ["notes", "amount"],
      sampleRows: [["Hello world", "$10.00"]],
      missingValue: missingValueResult([notesMissingValueProposal]),
      coercion: coercionResult([amountCoercionProposal]),
    });

    for (const report of result.stepReports) {
      expect(report.failureRate).toBe(0);
      expect(report.maxFailureRate).toBeCloseTo(0.01);
    }
  });

  it("surfaces no-change and dropped specialist outcomes in skippedProposals without touching the diff", () => {
    const result = buildAssembledPlan({
      nodeId: "node-1",
      planId: "plan-1",
      baseGraphVersion: 0,
      existingStepCount: 0,
      sampleColumns: ["notes", "amount"],
      sampleRows: [["Hello world", "$10.00"]],
      missingValue: missingValueResult([{ column: "notes", kind: "no-change", reason: "already clean" }]),
      coercion: coercionResult([{ column: "amount", kind: "dropped", reason: "retry also failed" }]),
    });

    expect(result.diff.ops).toHaveLength(0);
    expect(result.stepReports).toHaveLength(0);
    expect(result.skippedProposals).toEqual([
      { column: "notes", specialist: "missing-value", reason: "already clean" },
      { column: "amount", specialist: "coercion", reason: "retry also failed" },
    ]);
  });
});
