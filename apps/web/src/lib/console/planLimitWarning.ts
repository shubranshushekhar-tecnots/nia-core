/**
 * Console org-detail "Edit plan" form: staff-facing heads-up shown while
 * typing a new effective workflow/project limit that's lower than the
 * org's current usage. Purely informational — the enforcement triggers
 * (private.enforce_workflow_limit / private.enforce_project_limit,
 * 0053/0052) only fire on INSERT, never UPDATE/DELETE, so a lower limit
 * never touches existing rows; it just refuses new ones going forward.
 * `null` means no warning applies (limit not lower than current usage, or
 * unlimited).
 *
 * Generalized (subscription-model Phase 1) to cover both limit kinds via a
 * `noun` param — callers pass the *effective* limit (plan default, or the
 * override value when set), not the raw override field, since that's the
 * number that actually governs future inserts.
 */
export function formatLowerLimitWarning(used: number, newLimit: number | null, noun: "workflows" | "projects"): string | null {
  if (newLimit === null || newLimit >= used) return null;
  const verb = noun === "workflows" ? "create more" : "add more";
  return `This org has ${used} ${noun}; the new limit is ${newLimit}. Existing ${noun} stay; they can't ${verb}.`;
}
