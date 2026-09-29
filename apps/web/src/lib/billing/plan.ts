// Console v1 follow-up ("Slice 2 nearly approved" review, req. 2). Reads
// the real plan/limit apps/api's getDashboardStats() already resolves from
// org_plan (falling back to Pro/25 server-side for missing rows/personal
// workspaces — see apps/api/src/services/dashboard.ts's getOrgPlan) so a
// Slice 3a plan change actually reaches this customer-facing render,
// instead of the previous hardcoded constant. `limit: null` means
// unlimited (org_plan.workflow_limit's own column comment) — callers must
// not divide by it.

export type PlanUsage = {
  plan: string;
  limit: number | null;
  used: number;
};

export function getPlanUsage(workflowCount: number, planTier: string, workflowLimit: number | null): PlanUsage {
  return {
    plan: planTier,
    limit: workflowLimit,
    used: workflowCount,
  };
}
