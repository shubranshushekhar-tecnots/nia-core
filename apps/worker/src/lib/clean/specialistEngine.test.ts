import { describe, expect, it, vi, beforeEach } from "vitest";
import { computeColumnStats } from "../profile/stats.js";

/**
 * Phase 13, Step 4 / Step 9 — covers the plan's required unit test: "an
 * invalid specialist output (unknown function) is retried once, then
 * dropped and reported." Mocks the LLM gateway's `complete` directly (same
 * pattern as proposeMapping.test.ts) so this never makes a real call.
 */

const completeMock = vi.fn();
vi.mock("../llm/gatewayClient.js", () => ({
  complete: (...args: unknown[]) => completeMock(...args),
}));

const { runSpecialist } = await import("./specialistEngine.js");

beforeEach(() => {
  completeMock.mockReset();
});

const amountColumn = () => computeColumnStats("amount", "varchar", ["$10.00", "$25.50", "$3.75"]);

function trivialPrompt() {
  return [{ role: "user" as const, content: "propose" }];
}

describe("runSpecialist", () => {
  it("drops and reports a column whose output uses an unknown function, after one retry", async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({
          columns: [
            {
              action: "step",
              column: "amount",
              expression: { kind: "call", fn: "make_it_a_number", args: [{ kind: "field", name: "amount" }] },
              rationale: "strip currency and coerce",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          columns: [
            {
              action: "step",
              column: "amount",
              expression: { kind: "call", fn: "still_not_a_real_function", args: [{ kind: "field", name: "amount" }] },
              rationale: "strip currency and coerce",
            },
          ],
        }),
      );

    const result = await runSpecialist({
      specialist: "coercion",
      onFailure: "quarantine",
      llmNode: "test-node",
      columns: [amountColumn()],
      buildPrompt: trivialPrompt,
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ column: "amount", kind: "dropped" });
    expect((result.proposals[0] as { reason: string }).reason).toContain("retry also failed");
  });

  it("accepts a valid step on the first try with no retry", async () => {
    completeMock.mockResolvedValueOnce(
      JSON.stringify({
        columns: [
          {
            action: "step",
            column: "amount",
            expression: {
              kind: "call",
              fn: "to_number",
              args: [{ kind: "call", fn: "regex_replace", args: [{ kind: "field", name: "amount" }, { kind: "literal", value: "[$,]" }, { kind: "literal", value: "" }] }],
            },
            rationale: "strip $ and , then coerce to a number",
          },
        ],
      }),
    );

    const result = await runSpecialist({
      specialist: "coercion",
      onFailure: "quarantine",
      llmNode: "test-node",
      columns: [amountColumn()],
      buildPrompt: trivialPrompt,
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ column: "amount", kind: "step" });
    if (result.proposals[0]!.kind === "step") {
      expect(result.proposals[0]!.step.onFailure).toBe("quarantine");
      expect(result.proposals[0]!.step.name).toBe("amount");
    }
  });

  it("recovers on retry when the second attempt is valid", async () => {
    completeMock
      .mockResolvedValueOnce(
        JSON.stringify({
          columns: [{ action: "step", column: "amount", expression: { kind: "call", fn: "bogus_fn", args: [] }, rationale: "x" }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          columns: [{ action: "step", column: "amount", expression: { kind: "call", fn: "to_number", args: [{ kind: "field", name: "amount" }] }, rationale: "coerce" }],
        }),
      );

    const result = await runSpecialist({
      specialist: "coercion",
      onFailure: "quarantine",
      llmNode: "test-node",
      columns: [amountColumn()],
      buildPrompt: trivialPrompt,
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.proposals[0]).toMatchObject({ column: "amount", kind: "step" });
  });

  it("passes through a no-change response without any validation error", async () => {
    completeMock.mockResolvedValueOnce(
      JSON.stringify({ columns: [{ action: "no-change", column: "amount", reason: "already clean" }] }),
    );

    const result = await runSpecialist({
      specialist: "coercion",
      onFailure: "quarantine",
      llmNode: "test-node",
      columns: [amountColumn()],
      buildPrompt: trivialPrompt,
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.proposals[0]).toMatchObject({ column: "amount", kind: "no-change", reason: "already clean" });
  });

  it("returns no proposals and makes no LLM call when given no columns", async () => {
    const result = await runSpecialist({
      specialist: "missing-value",
      onFailure: "null",
      llmNode: "test-node",
      columns: [],
      buildPrompt: trivialPrompt,
    });

    expect(completeMock).not.toHaveBeenCalled();
    expect(result.proposals).toEqual([]);
  });
});
