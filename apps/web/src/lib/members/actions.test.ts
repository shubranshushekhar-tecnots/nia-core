import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Subscription Phase 2, Slice 7 "speed rule" tests — one allowed + one
 * refused case per action. withActingUser is mocked to just invoke its
 * callback against a fake `db` (whose `query` return value each test
 * configures), rather than a real Postgres connection — RLS itself is
 * proven separately by the RLS probe suite (supabase/tests/rls_probes.sql);
 * these tests only prove this module's own capability short-circuits and
 * rowCount-based error mapping. getPool is mocked to a dummy value since
 * it throws without DATABASE_URL (see lib/db/pool.ts) and is never
 * actually used once withActingUser itself is mocked.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));

const requireUserWithOrg = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireUserWithOrg: () => requireUserWithOrg() }));

const query = vi.fn();
vi.mock("@nia/db", () => ({ withActingUser: (_pool: unknown, _userId: string, fn: (db: unknown) => unknown) => fn({ query }) }));

const { changeMemberRole, removeMember } = await import("./actions");

const ORG = { id: "org-1", name: "Acme", slug: "acme", suspendedAt: null, suspendedReason: null };

function actingAs(userId: string, role: "member" | "admin" | "owner" | "viewer") {
  requireUserWithOrg.mockResolvedValue({ userId, email: `${userId}@example.com`, fullName: null, org: ORG, role });
}

describe("changeMemberRole", () => {
  beforeEach(() => {
    query.mockReset();
    requireUserWithOrg.mockReset();
  });

  it("allows an owner to promote a member to admin", async () => {
    actingAs("owner-1", "owner");
    query
      .mockResolvedValueOnce({ rows: [{ role: "member" }] }) // currentRoleOf
      .mockResolvedValueOnce({ rowCount: 1 }); // update

    const result = await changeMemberRole("member-1", "admin");

    expect(result).toEqual({});
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refuses an admin trying to change an owner's role", async () => {
    actingAs("admin-1", "admin");
    query.mockResolvedValueOnce({ rows: [{ role: "owner" }] }); // currentRoleOf

    const result = await changeMemberRole("owner-1", "member");

    expect(result.error).toBeTruthy();
    // Only currentRoleOf ran — assertCanManageMember rejected before any update query.
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("removeMember", () => {
  beforeEach(() => {
    query.mockReset();
    requireUserWithOrg.mockReset();
  });

  function formData(targetUserId: string) {
    const fd = new FormData();
    fd.set("targetUserId", targetUserId);
    return fd;
  }

  it("allows a plain member to remove themselves (self-leave bypasses the capability check)", async () => {
    const selfId = "11111111-1111-1111-1111-111111111111";
    actingAs(selfId, "member");
    query
      .mockResolvedValueOnce({ rows: [{ role: "member" }] }) // currentRoleOf
      .mockResolvedValueOnce({ rowCount: 1 }); // delete

    const result = await removeMember({}, formData(selfId));

    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refuses a plain member trying to remove someone else", async () => {
    const selfId = "11111111-1111-1111-1111-111111111111";
    const otherId = "22222222-2222-2222-2222-222222222222";
    actingAs(selfId, "member");
    query.mockResolvedValueOnce({ rows: [{ role: "member" }] }); // currentRoleOf(other)

    const result = await removeMember({}, formData(otherId));

    expect(result?.error).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
