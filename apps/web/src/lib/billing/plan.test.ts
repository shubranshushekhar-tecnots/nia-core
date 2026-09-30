import { describe, expect, it } from "vitest";
import type { DashboardStats } from "@/lib/dashboard/types";
import { getPlanUsage } from "./plan";

/**
 * Subscription Phase 3, Slice 4 — getPlanUsage() became a pure
 * DashboardStats -> PlanUsage mapper (previously five positional args);
 * this proves every field carries through, including the new rows/Copilot
 * usage and periodDaysLeft.
 */
describe("getPlanUsage", () => {
  it("maps every DashboardStats field through to PlanUsage, unit-changed only", () => {
    const stats: DashboardStats = {
      projectCount: 1,
      workflowCount: 2,
      activeWorkflowCount: 1,
      planTier: "Pro",
      workflowLimit: null,
      projectLimit: 5,
      rowsLimit: 2000000,
      rowsUsed: 1500000,
      copilotLimit: 500,
      copilotUsed: 480,
      periodDaysLeft: 9,
    };

    expect(getPlanUsage(stats)).toEqual({
      plan: "Pro",
      workflowLimit: null,
      workflowUsed: 2,
      projectLimit: 5,
      projectUsed: 1,
      rowsLimit: 2000000,
      rowsUsed: 1500000,
      copilotLimit: 500,
      copilotUsed: 480,
      periodDaysLeft: 9,
    });
  });
});
