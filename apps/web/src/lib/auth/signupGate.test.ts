import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Email Phase 3 — lean coverage for the signup gate's three allow-paths
// (approved access_requests row, pending/unexpired platform_invites row,
// one-time Redis bridge flag) plus the two read-only token-peek helpers.
// withServiceRole/getPool are stubbed down to the one `query` seam being
// exercised, same convention as lib/auth/actions.test.ts.

const query = vi.fn();
vi.mock("@nia/db", () => ({ withServiceRole: (_pool: unknown, fn: (db: { query: typeof query }) => unknown) => fn({ query }) }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));

const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();
vi.mock("@/lib/auth/rateLimit", () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));

const {
  isSignupAllowed,
  allowSignupOnce,
  checkSignupAllowed,
  isOrgInviteTokenValid,
  peekPlatformInviteEmail,
} = await import("./signupGate");

beforeEach(() => {
  query.mockReset();
  redisGet.mockReset();
  redisSet.mockReset();
  redisDel.mockReset();
});

describe("isSignupAllowed", () => {
  it("is true for an email with an approved access_requests row", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // access_requests check
    const result = await isSignupAllowed("approved@example.com");
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("is true for an email with a pending, unexpired platform_invites row", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // access_requests: none
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // platform_invites: found
    const result = await isSignupAllowed("invited@example.com");
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("is false for an unknown email with no standing allow-path", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    const result = await isSignupAllowed("unknown@example.com");
    expect(result).toBe(false);
  });
});

describe("checkSignupAllowed", () => {
  it("returns true and never touches Redis when a standing allow-path already matches", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    const result = await checkSignupAllowed("approved@example.com");
    expect(result).toBe(true);
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("consumes the one-time Redis flag (GET+DEL) when no standing allow-path matches", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    redisGet.mockResolvedValueOnce("1");

    const result = await checkSignupAllowed("bridged@example.com");

    expect(result).toBe(true);
    expect(redisGet).toHaveBeenCalledWith("signup-allow:bridged@example.com");
    expect(redisDel).toHaveBeenCalledWith("signup-allow:bridged@example.com");
  });

  it("returns false when neither a standing allow-path nor the Redis flag matches", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    redisGet.mockResolvedValueOnce(null);

    const result = await checkSignupAllowed("ghost@example.com");

    expect(result).toBe(false);
    expect(redisDel).not.toHaveBeenCalled();
  });
});

describe("allowSignupOnce", () => {
  it("sets the bridge flag with a 600s TTL, keyed on the lowercased email", async () => {
    await allowSignupOnce("Mixed-Case@Example.com");
    expect(redisSet).toHaveBeenCalledWith("signup-allow:mixed-case@example.com", "1", "EX", 600);
  });
});

describe("isOrgInviteTokenValid", () => {
  it("is true when invite_links has a matching, unrevoked, unexpired, under-max-uses row", async () => {
    query.mockResolvedValueOnce({ rows: [{ ok: true }] });
    const result = await isOrgInviteTokenValid("raw-token");
    expect(result).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([createHash("sha256").update("raw-token").digest("hex")]);
    expect(sql).toMatch(/invite_links/);
  });

  it("is false for an unknown/expired/revoked token", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await isOrgInviteTokenValid("bad-token");
    expect(result).toBe(false);
  });
});

describe("peekPlatformInviteEmail", () => {
  it("returns the lowercased email for a pending, unexpired platform invite", async () => {
    query.mockResolvedValueOnce({ rows: [{ email: "Invitee@Example.com" }] });
    const result = await peekPlatformInviteEmail("raw-token");
    expect(result).toBe("invitee@example.com");
  });

  it("returns null for an unknown/expired/non-pending token", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await peekPlatformInviteEmail("bad-token");
    expect(result).toBeNull();
  });
});
