import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

/**
 * Console v1 build order step 4 (docs/plans/console-plan.md §5): an active
 * platform_staff row lets the request through; a revoked/missing one 403s.
 * withServiceRole is mocked at the module boundary — same convention
 * auth.test.ts uses for auth.api.getSession — since it's @nia/db's own,
 * already-tested primitive, not something this middleware re-verifies.
 */
const withServiceRole = vi.fn();
// createDbPool is stubbed too: lib/dbPool.ts (imported transitively via
// requireStaff.ts) calls it at module load time to build the process pool.
vi.mock("@nia/db", () => ({
  withServiceRole,
  createDbPool: vi.fn(),
}));

const { requireStaff } = await import("./requireStaff.js");

function createReq(authUser?: { id: string; email: string }): Request {
  return { authUser } as unknown as Request;
}

function createRes(): Response {
  return {} as Response;
}

beforeEach(() => {
  withServiceRole.mockReset();
});

describe("requireStaff", () => {
  it("calls next() with no error when the caller has an active platform_staff row", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 1 });

    const req = createReq({ id: "staff-1", email: "staff@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("403s when the caller has no platform_staff row at all", async () => {
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const req = createReq({ id: "user-1", email: "user@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "NOT_STAFF" }));
  });

  it("403s when the caller's platform_staff row has been revoked", async () => {
    // requireStaff's own query filters `revoked_at is null`, so a revoked
    // row surfaces to this middleware exactly like no row at all.
    withServiceRole.mockResolvedValue({ rowCount: 0 });

    const req = createReq({ id: "revoked-1", email: "revoked@nia.dev" });
    const next = vi.fn();
    await requireStaff(req, createRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "NOT_STAFF" }));
  });

  it("rejects a request with no authUser without querying platform_staff", async () => {
    const req = createReq(undefined);
    const next = vi.fn();
    await requireStaff(req, createRes(), next);

    expect(withServiceRole).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
