// TODO(phase-8): replace with real billing data once plans/usage are
// tracked (Stripe subscription + a usage table). For now every org is
// treated as "Pro" with a static workflow-count limit so the Home
// dashboard has something real to render against.

export type PlanUsage = {
  plan: string;
  limit: number;
  used: number;
};

export function getPlanUsage(workflowCount: number): PlanUsage {
  return {
    plan: 'Pro',
    limit: 25,
    used: workflowCount,
  };
}
