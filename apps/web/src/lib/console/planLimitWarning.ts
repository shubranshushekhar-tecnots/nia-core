/**
 * Console org-detail "Edit plan" form: staff-facing heads-up shown while
 * typing a new workflow_limit that's lower than the org's current workflow
 * count. Purely informational — the trigger (0045_workflow_plan_enforcement.sql)
 * only fires on INSERT, never UPDATE/DELETE, so a lower limit never touches
 * existing rows; it just refuses new ones going forward. `null` means no
 * warning applies (limit not lower than current usage, or field left blank
 * for unlimited).
 */
export function formatLowerLimitWarning(workflowsUsed: number, newLimit: number | null): string | null {
  if (newLimit === null || newLimit >= workflowsUsed) return null;
  return `This org has ${workflowsUsed} workflows; the new limit is ${newLimit}. Existing workflows stay; they can't create more.`;
}
