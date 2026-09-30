// Console v1 follow-up ("Slice 2 nearly approved" review, req. 2). Reads
// the real plan/limit apps/api's getDashboardStats() already resolves from
// org_plan/owner_plan -> plans (0049/0050/0051 — see
// apps/api/src/services/dashboard.ts's getOrgPlan) so a Console plan change
// actually reaches this customer-facing render, instead of a hardcoded
// constant. `limit: null` means unlimited (workflow_limit/project_limit's
// own column comments) — callers must not divide by it.
//
// Subscription model Phase 1: extended to carry project usage alongside
// workflow usage (previously workflow-only) — DashboardStats now resolves
// both effective limits from the same plan row.
//
// Subscription Phase 3, Slice 4: extended again for rows-moved/Copilot
// usage + days left in the current calendar month. DashboardStats already
// carries every field this needs, so getPlanUsage now takes the whole
// object instead of five (soon to be ten) positional args.

import type { DashboardStats } from "@/lib/dashboard/types";

export type PlanUsage = {
  plan: string;
  workflowLimit: number | null;
  workflowUsed: number;
  projectLimit: number | null;
  projectUsed: number;
  rowsLimit: number | null;
  rowsUsed: number;
  copilotLimit: number | null;
  copilotUsed: number;
  periodDaysLeft: number;
};

export function getPlanUsage(stats: DashboardStats): PlanUsage {
  return {
    plan: stats.planTier,
    workflowLimit: stats.workflowLimit,
    workflowUsed: stats.workflowCount,
    projectLimit: stats.projectLimit,
    projectUsed: stats.projectCount,
    rowsLimit: stats.rowsLimit,
    rowsUsed: stats.rowsUsed,
    copilotLimit: stats.copilotLimit,
    copilotUsed: stats.copilotUsed,
    periodDaysLeft: stats.periodDaysLeft,
  };
}
