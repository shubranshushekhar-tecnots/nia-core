import { describe, expect, it } from "vitest";
import { decideRetryOrRefuse, hasError } from "./shared.js";
import type { PlanStateType } from "../state.js";

/**
 * Direct unit coverage for the one-retry decision (item 7 of the Session 1
 * review): the golden suite's live LLM calls can't deterministically force
 * a first-pass validation failure that then recovers on retry (or doesn't),
 * so this exercises decideRetryOrRefuse's branch logic directly rather than
 * through the full LangGraph pipeline — same fallback the review itself
 * allowed for this exact reason.
 */
function stateWithAttempts(planGenAttempts: number): PlanStateType {
  return { planGenAttempts } as PlanStateType;
}

describe("decideRetryOrRefuse", () => {
  it("retries after the first generatePlan attempt (planGenAttempts=1)", () => {
    const result = decideRetryOrRefuse(stateWithAttempts(1), "entity does not exist", "partial-failure");
    expect(result).toEqual({ lastValidationOutcome: "retry", feedback: "entity does not exist" });
  });

  it("refuses after the second generatePlan attempt (planGenAttempts=2), preserving message + kind", () => {
    const result = decideRetryOrRefuse(stateWithAttempts(2), "entity does not exist", "partial-failure");
    expect(result).toEqual({ lastValidationOutcome: "refused", refusalKind: "partial-failure", error: "entity does not exist" });
  });

  it("refuses (never retries a third time) once attempts exceed the cap", () => {
    const result = decideRetryOrRefuse(stateWithAttempts(3), "would breach the row cap", "capacity-limit");
    expect(result.lastValidationOutcome).toBe("refused");
    expect(result.refusalKind).toBe("capacity-limit");
  });

  it("carries capacity-limit refusalKind through on refusal", () => {
    const result = decideRetryOrRefuse(stateWithAttempts(2), "would produce 5000 groups, exceeding the 1000-row cap", "capacity-limit");
    expect(result).toEqual({
      lastValidationOutcome: "refused",
      refusalKind: "capacity-limit",
      error: "would produce 5000 groups, exceeding the 1000-row cap",
    });
  });

  it("carries unsupported-operation refusalKind through on refusal", () => {
    const result = decideRetryOrRefuse(stateWithAttempts(2), "cycle detected", "unsupported-operation");
    expect(result.refusalKind).toBe("unsupported-operation");
  });
});

describe("hasError", () => {
  it("is false when error is undefined", () => {
    expect(hasError({})).toBe(false);
  });

  it("is true when error is set, even to an empty string", () => {
    expect(hasError({ error: "boom" })).toBe(true);
    expect(hasError({ error: "" })).toBe(true);
  });
});
