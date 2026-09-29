import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * 0046_org_suspension.sql / attachActor's new 403 (Addition 4): a caller
 * whose resolved org (the "oldest membership wins" row attachActor's own
 * header comment describes) is suspended gets ORG_SUSPENDED instead of
 * having req.actor attached. req.withUser is faked directly here (same
 * spirit as requireStaff.test.ts mocking withServiceRole at the module
 * boundary) — attachActor never imports @nia/db itself, it only calls
 * whatever attachDb already put on req.withUser, so there's nothing to
 * vi.mock() at the module level for this file.
 */
const { attachActor } = await import("./actor.js");

function createWithUser(options: {
  profileRow?: { full_name: string | null } | null;
  membershipRow?: {
    role: string;
    org_id: string;
    org_name: string;
    org_slug: string;
    suspended_at: string | null;
    suspended_reason: string | null;
  } | null;
}) {
  const { profileRow = null, membershipRow = null } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM profiles")) return { rows: profileRow ? [profileRow] : [] };
    if (sql.includes("FROM organization_members")) return { rows: membershipRow ? [membershipRow] : [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const withUser = vi.fn(async (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return withUser;
}

function createReq(options: {
  authUser?: { id: string; email: string };
  withUser?: ReturnType<typeof createWithUser>;
}): Request {
  return { authUser: options.authUser, withUser: options.withUser } as unknown as Request;
}

function createRes(): Response {
  return {} as Response;
}

/**
 * attachActor is wrapped in asyncHandler, whose returned RequestHandler
 * does `fn(req, res, next).catch(next)` without returning/awaiting that
 * promise (see asyncHandler.ts's header comment) — so `attachActor(...)`
 * itself resolves to `undefined` on the very next microtask, well before
 * the Promise.all of two nested async mocks (withUser -> query) inside it
 * has actually settled and called next(). Awaiting a promise that only
 * resolves once next() is actually invoked sidesteps that race instead of
 * relying on microtask-count luck.
 */
async function invoke(req: Request, res: Response): Promise<ReturnType<typeof vi.fn>> {
  let resolveNext: () => void;
  const nextCalled = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  const next = vi.fn(() => resolveNext());
  void attachActor(req, res, next);
  await nextCalled;
  return next;
}

describe("attachActor", () => {
  it("attaches req.actor and calls next() with no error for a member of a non-suspended org", async () => {
    const withUser = createWithUser({
      profileRow: { full_name: "Ada Member" },
      membershipRow: {
        role: "owner",
        org_id: "org-1",
        org_name: "Acme Inc",
        org_slug: "acme-inc",
        suspended_at: null,
        suspended_reason: null,
      },
    });
    const req = createReq({ authUser: { id: "user-1", email: "ada@acme.test" }, withUser });

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith();
    expect(req.actor).toEqual({
      userId: "user-1",
      email: "ada@acme.test",
      fullName: "Ada Member",
      org: { id: "org-1", name: "Acme Inc", slug: "acme-inc" },
      role: "owner",
    });
  });

  it("403s with ORG_SUSPENDED (and the reason) when the resolved org is suspended, without attaching req.actor", async () => {
    const withUser = createWithUser({
      profileRow: { full_name: "Ada Member" },
      membershipRow: {
        role: "owner",
        org_id: "org-1",
        org_name: "Acme Inc",
        org_slug: "acme-inc",
        suspended_at: "2026-02-01T00:00:00.000Z",
        suspended_reason: "Non-payment",
      },
    });
    const req = createReq({ authUser: { id: "user-1", email: "ada@acme.test" }, withUser });

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        code: "ORG_SUSPENDED",
        details: { reason: "Non-payment" },
      }),
    );
    expect(req.actor).toBeUndefined();
  });

  it("lets an org-less (individual) user through even though there is no membership row to check for suspension", async () => {
    const withUser = createWithUser({ profileRow: { full_name: "Solo User" }, membershipRow: null });
    const req = createReq({ authUser: { id: "user-2", email: "solo@nia.dev" }, withUser });

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith();
    expect(req.actor).toEqual({
      userId: "user-2",
      email: "solo@nia.dev",
      fullName: "Solo User",
      org: null,
      role: "individual",
    });
  });

  it("rejects a request with no authUser/withUser without querying anything", async () => {
    const req = createReq({});

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: "NOT_AUTHENTICATED" }));
  });
});
