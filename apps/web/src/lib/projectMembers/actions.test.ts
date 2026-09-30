import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Subscription Phase 2, Slice 7 "speed rule" tests — one allowed + one
 * refused case per action. Same mocking approach as members/actions.test.ts
 * (see that file's header comment): withActingUser is mocked to invoke its
 * callback against a fake `db`, and the "refused" cases assert on the
 * rowCount === 0 path this module maps to a friendly error — the real
 * enforcement is project_members' own RLS (0054_project_members.sql),
 * proven separately by the RLS probe suite.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));

const requireUserWithOrg = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireUserWithOrg: () => requireUserWithOrg() }));

const query = vi.fn();
vi.mock("@nia/db", () => ({ withActingUser: (_pool: unknown, _userId: string, fn: (db: unknown) => unknown) => fn({ query }) }));

const { addProjectMember, removeProjectMember } = await import("./actions");

const ORG = { id: "org-1", name: "Acme", slug: "acme", suspendedAt: null, suspendedReason: null };
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";

function actingAs(userId: string, role: "member" | "admin" | "owner" | "viewer") {
  requireUserWithOrg.mockResolvedValue({ userId, email: `${userId}@example.com`, fullName: null, org: ORG, role });
}

describe("addProjectMember", () => {
  beforeEach(() => {
    query.mockReset();
    requireUserWithOrg.mockReset();
  });

  it("allows an admin to add an org member to the project", async () => {
    actingAs("admin-1", "admin");
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await addProjectMember(PROJECT_ID, "member-1");

    expect(result).toEqual({});
  });

  it("refuses a plain member (RLS rejects the insert, 0 rows affected)", async () => {
    actingAs("member-1", "member");
    query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await addProjectMember(PROJECT_ID, "member-2");

    expect(result.error).toBeTruthy();
  });
});

describe("removeProjectMember", () => {
  beforeEach(() => {
    query.mockReset();
    requireUserWithOrg.mockReset();
  });

  function formData(targetUserId: string) {
    const fd = new FormData();
    fd.set("projectId", PROJECT_ID);
    fd.set("targetUserId", targetUserId);
    return fd;
  }

  it("allows a plain member to leave the project themselves", async () => {
    const selfId = "11111111-1111-1111-1111-111111111111";
    actingAs(selfId, "member");
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await removeProjectMember({}, formData(selfId));

    expect(result).toEqual({ success: true });
  });

  it("refuses a plain member removing someone else (RLS rejects the delete, 0 rows affected)", async () => {
    const selfId = "11111111-1111-1111-1111-111111111111";
    const otherId = "22222222-2222-2222-2222-222222222222";
    actingAs(selfId, "member");
    query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await removeProjectMember({}, formData(otherId));

    expect(result?.error).toBeTruthy();
  });
});
