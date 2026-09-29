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

export type PlanUsage = {
  plan: string;
  workflowLimit: number | null;
  workflowUsed: number;
  projectLimit: number | null;
  projectUsed: number;
};

export function getPlanUsage(
  workflowCount: number,
  projectCount: number,
  planTier: string,
  workflowLimit: number | null,
  projectLimit: number | null,
): PlanUsage {
  return {
    plan: planTier,
    workflowLimit,
    workflowUsed: workflowCount,
    projectLimit,
    projectUsed: projectCount,
  };
}
