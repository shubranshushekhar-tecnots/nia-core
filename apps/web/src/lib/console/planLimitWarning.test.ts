import { describe, expect, it } from "vitest";
import { formatLowerLimitWarning } from "./planLimitWarning";

describe("formatLowerLimitWarning", () => {
  it("warns with the exact customer/staff-facing copy when the new limit is below current usage", () => {
    expect(formatLowerLimitWarning(18, 10)).toBe(
      "This org has 18 workflows; the new limit is 10. Existing workflows stay; they can't create more.",
    );
  });

  it("returns null when the new limit is at or above current usage", () => {
    expect(formatLowerLimitWarning(18, 18)).toBeNull();
    expect(formatLowerLimitWarning(18, 25)).toBeNull();
  });

  it("returns null when the field is blank (unlimited)", () => {
    expect(formatLowerLimitWarning(18, null)).toBeNull();
  });

  it("returns null for an org with zero workflows regardless of limit", () => {
    expect(formatLowerLimitWarning(0, 1)).toBeNull();
  });
});
