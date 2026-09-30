import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Subscription Phase 2, Slice 3 ("Viewer role"): requireCapability is the
 * API-layer gate that must 403 a viewer's attempt to start/cancel a run
 * (apps/api/src/routes/runs.ts gates both POST /:id/run and
 * /:id/run/cancel with requireCapability("workflows.run")). No mocking is
 * needed — requireCapability's only dependency is @nia/schemas's pure
 * assertCan()/CAPABILITY_MATRIX, so this exercises the real capability
 * matrix, not a stand-in for it. Pattern (plain req/res/next objects, cast
 * `as unknown as Request`, direct middleware invocation) mirrors
 * requireStaff.test.ts.
 */
const { requireCapability } = await import("./requireCapability.js");

function createReq(role: string | undefined): Request {
  return {
    actor: role === undefined ? undefined : { userId: "u1", email: "u1@nia.dev", fullName: null, org: null, role },
  } as unknown as Request;
}

function createRes(): Response {
  return {} as Response;
}

describe("requireCapability", () => {
  it("403s a viewer's attempt to start/cancel a run (workflows.run)", () => {
    const req = createReq("viewer");
    const next = vi.fn();
    requireCapability("workflows.run")(req, createRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "INSUFFICIENT_ROLE" }));
  });

  it("calls next() with no error for a member starting a run", () => {
    const req = createReq("member");
    const next = vi.fn();
    requireCapability("workflows.run")(req, createRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("401s when no actor has been attached yet", () => {
    const req = createReq(undefined);
    const next = vi.fn();
    requireCapability("workflows.run")(req, createRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: "NOT_AUTHENTICATED" }));
  });

  // Subscription Phase 2, Slice 5 (DECISION-F, docs/decisions.md): grants.create
  // was reopened to admin/owner only, reversing Slice 5's earlier all-role
  // decision — apps/api/src/routes/grants.ts gates POST /:connectionId/grants
  // with requireCapability("grants.create").
  it("403s a plain member's attempt to create a write grant (grants.create)", () => {
    const req = createReq("member");
    const next = vi.fn();
    requireCapability("grants.create")(req, createRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: "INSUFFICIENT_ROLE" }));
  });

  it("calls next() with no error for an admin creating a write grant", () => {
    const req = createReq("admin");
    const next = vi.fn();
    requireCapability("grants.create")(req, createRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});
