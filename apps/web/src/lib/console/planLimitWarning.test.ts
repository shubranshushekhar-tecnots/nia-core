import { describe, expect, it } from "vitest";
import { formatLowerLimitWarning } from "./planLimitWarning";

describe("formatLowerLimitWarning", () => {
  it("warns with the exact customer/staff-facing copy when the new limit is below current usage (workflows)", () => {
    expect(formatLowerLimitWarning(18, 10, "workflows")).toBe(
      "This org has 18 workflows; the new limit is 10. Existing workflows stay; they can't create more.",
    );
  });

  it("warns with the projects-specific verb when the new limit is below current usage (projects)", () => {
    expect(formatLowerLimitWarning(6, 3, "projects")).toBe(
      "This org has 6 projects; the new limit is 3. Existing projects stay; they can't add more.",
    );
  });

  it("returns null when the new limit is at or above current usage", () => {
    expect(formatLowerLimitWarning(18, 18, "workflows")).toBeNull();
    expect(formatLowerLimitWarning(18, 25, "workflows")).toBeNull();
  });

  it("returns null when the field is blank (unlimited)", () => {
    expect(formatLowerLimitWarning(18, null, "workflows")).toBeNull();
  });

  it("returns null for an org with zero workflows regardless of limit", () => {
    expect(formatLowerLimitWarning(0, 1, "workflows")).toBeNull();
  });
});
