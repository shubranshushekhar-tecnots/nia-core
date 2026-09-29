import { describe, it, expect } from "vitest";
import { pickActiveMembership } from "./pickActiveMembership.js";

/**
 * Org switcher (Subscription Phase 2): pickActiveMembership is the pure
 * core of requireUser()'s org resolution, split out so it's directly
 * unit-testable without mocking Next's cookies()/DB layer — mirrors
 * apps/api/src/middleware/actor.test.ts's equivalent coverage on the
 * apps/api side.
 */
function membership(orgId: string, overrides: Partial<Parameters<typeof pickActiveMembership>[0][number]> = {}) {
  return {
    role: "member",
    created_at: "2026-01-01T00:00:00.000Z",
    org_id: orgId,
    org_name: `Org ${orgId}`,
    org_slug: orgId,
    suspended_at: null,
    suspended_reason: null,
    ...overrides,
  };
}

describe("pickActiveMembership", () => {
  it("picks the membership matching activeOrgId when present", () => {
    const memberships = [membership("org-oldest"), membership("org-chosen")];

    const result = pickActiveMembership(memberships, "org-chosen");

    expect(result?.org_id).toBe("org-chosen");
  });

  it("falls back to the first (oldest) membership when activeOrgId is null", () => {
    const memberships = [membership("org-oldest"), membership("org-newer")];

    const result = pickActiveMembership(memberships, null);

    expect(result?.org_id).toBe("org-oldest");
  });

  it("falls back to the first (oldest) membership when activeOrgId doesn't match any membership (stale/left org)", () => {
    const memberships = [membership("org-oldest"), membership("org-newer")];

    const result = pickActiveMembership(memberships, "org-left-long-ago");

    expect(result?.org_id).toBe("org-oldest");
  });

  it("returns undefined for an org-less (individual) user with no memberships", () => {
    const result = pickActiveMembership([], null);

    expect(result).toBeUndefined();
  });
});
