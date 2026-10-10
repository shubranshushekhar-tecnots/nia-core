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

/**
 * Plan-visibility work: the "grant expires in X days" / "grant expired —
 * reverted to base plan" note shown near the plan name on both
 * ConsoleOrgDetailClient and ConsoleUserDetailClient. `grantExpired` is the
 * server's own already-resolved flag (ConsoleOrgDetail.grantExpired /
 * ConsoleIndividualPlan.grantExpired) — this function never recomputes
 * expiry itself, it only formats what the API already decided, same
 * "server is the single source of truth for the expiry fallback" rule the
 * rest of this feature follows. `null` means no grant expiry is set at all
 * (nothing to show). Unlike the original design, an expired grant reverts
 * to the org's/owner's own BASE plan (`planId`), never a hardcoded Free —
 * so the message deliberately doesn't name a specific plan here (the base
 * plan name is already shown right next to this note).
 */
export function formatPlanExpiry(grantExpiresAt: string | null, grantExpired: boolean): string | null {
  if (grantExpiresAt === null) return null;
  if (grantExpired) return 'Grant expired — reverted to base plan';
  const days = Math.ceil((new Date(grantExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Grant expires today';
  if (days === 1) return 'Grant expires in 1 day';
  return `Grant expires in ${days} days`;
}
