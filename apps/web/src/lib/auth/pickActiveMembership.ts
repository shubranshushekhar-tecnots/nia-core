export type MembershipRow = {
  role: string;
  created_at: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  suspended_at: string | null;
  suspended_reason: string | null;
};

/**
 * Pure org-selection logic used by requireUser() (session.ts) and mirrored
 * by apps/api's attachActor middleware (see that file's header comment).
 * Split into its own dependency-free module — session.ts pulls in
 * next/headers and React's cache(), which only run under the RSC runtime,
 * so this couldn't be unit-tested directly from that file under plain
 * vitest. Memberships must already be ordered oldest-first (created_at
 * asc); picks the row matching activeOrgId if present and valid, else
 * falls back to the oldest membership — identical fallback to pre-switcher
 * behaviour.
 */
export function pickActiveMembership(
  memberships: MembershipRow[],
  activeOrgId: string | null,
): MembershipRow | undefined {
  return (activeOrgId ? memberships.find((m) => m.org_id === activeOrgId) : undefined) ?? memberships[0];
}
