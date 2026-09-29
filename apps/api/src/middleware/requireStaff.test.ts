import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

/**
 * Console v1 build order step 4 (docs/plans/console-plan.md §5): an active
 * platform_staff row lets the request through; a revoked/missing one 403s.
 * withServiceRole is mocked at the module boundary — same convention
 * auth.test.ts uses for auth.api.getSession — since it's @nia/db's own,
 * already-tested primitive, not something this middleware re-verifies.
 *
 * Slice 4 additions (§4b, decision 17): once past the platform_staff check,
 * requireStaff makes its OWN auth.api.getSession() call (see requireStaff.ts's
 * header comment for why) to read session.twoFactorVerifiedAt/createdAt —
 * mocked here the same way auth.test.ts mocks it.
 */
const withServiceRole = vi.fn();
// createDbPool is stubbed too: lib/dbPool.ts (imported transitively via
// requireStaff.ts) calls it at module load time to build the process pool.
vi.mock("@nia/db", () => ({
  withServiceRole,
  createDbPool: vi.fn(),
}));

const getSession = vi.fn();
vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession } },
}));

const { requireStaff } = await import("./requireStaff.js");

function createReq(authUser?: { id: string; email: string }, authorization = "Bearer good-token"): Request {
  return {
    authUser,
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  } as unknown as Request;
}

function createRes(): Response {
  return {} as Response;
}

// requireStaff is wrapped by asyncHandler, which does NOT return its inner
// promise (`fn(req,res,next).catch(next)` — see asyncHandler.ts) — so
// `await requireStaff(...)` only waits one microtask tick, not until the
// handler's own internal awaits (withServiceRole, then getSession) finish.
// A single macrotask flush guarantees every pending microtask has settled
// first, however many awaits requireStaff chains internally.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A session that's already passed 2FA well within STAFF_SESSION_MAX_AGE_SECONDS
// (default 28800s = 8h) — the happy path every non-2FA-specific test below uses.
function verifiedSession() {
  return {
    session: {
      createdAt: new Date(),
      twoFactorVerifiedAt: new Date(),
    },
  };
}

beforeEach(() => {
  withServiceRole.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue(verifiedSession());
});

describe("requireStaff", () => {
  it("calls next() with no error when the caller has an active platform_staff row", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const req = createReq({ id: "staff-1", email: "staff@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith();
  });

  it("403s when the caller has no platform_staff row at all", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const req = createReq({ id: "user-1", email: "user@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "NOT_STAFF" }));
  });

  it("403s when the caller's platform_staff row has been revoked", async () => {
    // requireStaff's own query filters `revoked_at is null`, so a revoked
    // row surfaces to this middleware exactly like no row at all.
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const req = createReq({ id: "revoked-1", email: "revoked@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "NOT_STAFF" }));
  });

  it("rejects a request with no authUser without querying platform_staff", async () => {
    const req = createReq(undefined);
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(withServiceRole).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("403s STAFF_2FA_REQUIRED when the session has never passed a 2FA challenge", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 1 });
    getSession.mockResolvedValue({ session: { createdAt: new Date(), twoFactorVerifiedAt: null } });

    const req = createReq({ id: "staff-1", email: "staff@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "STAFF_2FA_REQUIRED" }));
  });

  it("403s STAFF_SESSION_EXPIRED when the session is older than STAFF_SESSION_MAX_AGE_SECONDS", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 1 });
    // Default STAFF_SESSION_MAX_AGE_SECONDS is 28800s (8h) — 9h old exceeds it.
    const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
    getSession.mockResolvedValue({ session: { createdAt: nineHoursAgo, twoFactorVerifiedAt: new Date() } });

    const req = createReq({ id: "staff-1", email: "staff@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "STAFF_SESSION_EXPIRED" }));
  });

  it("calls next() with no error for a 2FA-verified session within the max age", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 1 });
    getSession.mockResolvedValue(verifiedSession());

    const req = createReq({ id: "staff-1", email: "staff@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);
    await flush();

    expect(next).toHaveBeenCalledWith();
  });
});
