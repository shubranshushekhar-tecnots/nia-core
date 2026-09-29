import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * 0046_org_suspension.sql / attachActor's new 403 (Addition 4): a caller
 * whose resolved org is suspended gets ORG_SUSPENDED instead of having
 * req.actor attached. req.withUser is faked directly here (same spirit as
 * requireStaff.test.ts mocking withServiceRole at the module boundary) —
 * attachActor never imports @nia/db itself, it only calls whatever
 * attachDb already put on req.withUser, so there's nothing to vi.mock() at
 * the module level for this file.
 *
 * Org switcher (Subscription Phase 2, Change #7): membershipRows is now a
 * plural array (attachActor's query no longer has LIMIT 1), and createReq
 * accepts an optional `cookie` header to exercise the nia_active_org
 * resolution — including proving that a *different*, suspended
 * membership never blocks a request acting in a healthy active org.
 */
const { attachActor } = await import("./actor.js");

type MembershipRow = {
  role: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  suspended_at: string | null;
  suspended_reason: string | null;
};

function createWithUser(options: {
  profileRow?: { full_name: string | null } | null;
  membershipRows?: MembershipRow[];
}) {
  const { profileRow = null, membershipRows = [] } = options;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM profiles")) return { rows: profileRow ? [profileRow] : [] };
    if (sql.includes("FROM organization_members")) return { rows: membershipRows };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const withUser = vi.fn(async (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }));
  return withUser;
}

function createReq(options: {
  authUser?: { id: string; email: string };
  withUser?: ReturnType<typeof createWithUser>;
  cookie?: string;
}): Request {
  return {
    authUser: options.authUser,
    withUser: options.withUser,
    header: (name: string) => (name.toLowerCase() === "cookie" ? options.cookie : undefined),
  } as unknown as Request;
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
      membershipRows: [
        {
          role: "owner",
          org_id: "org-1",
          org_name: "Acme Inc",
          org_slug: "acme-inc",
          suspended_at: null,
          suspended_reason: null,
        },
      ],
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
      membershipRows: [
        {
          role: "owner",
          org_id: "org-1",
          org_name: "Acme Inc",
          org_slug: "acme-inc",
          suspended_at: "2026-02-01T00:00:00.000Z",
          suspended_reason: "Non-payment",
        },
      ],
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
    const withUser = createWithUser({ profileRow: { full_name: "Solo User" }, membershipRows: [] });
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

  it("org switcher: a multi-org user with a matching nia_active_org cookie resolves the cookie's org, not the oldest one", async () => {
    const withUser = createWithUser({
      profileRow: { full_name: "Multi Org" },
      membershipRows: [
        {
          role: "member",
          org_id: "org-oldest",
          org_name: "Oldest Org",
          org_slug: "oldest-org",
          suspended_at: null,
          suspended_reason: null,
        },
        {
          role: "admin",
          org_id: "org-chosen",
          org_name: "Chosen Org",
          org_slug: "chosen-org",
          suspended_at: null,
          suspended_reason: null,
        },
      ],
    });
    const req = createReq({
      authUser: { id: "user-3", email: "multi@nia.dev" },
      withUser,
      cookie: "nia_active_org=org-chosen; other_cookie=x",
    });

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith();
    expect(req.actor).toEqual({
      userId: "user-3",
      email: "multi@nia.dev",
      fullName: "Multi Org",
      org: { id: "org-chosen", name: "Chosen Org", slug: "chosen-org" },
      role: "admin",
    });
  });

  it("org switcher (Change #7): a suspended non-active org never blocks a request acting in a healthy active org", async () => {
    const withUser = createWithUser({
      profileRow: { full_name: "Multi Org" },
      membershipRows: [
        {
          role: "owner",
          org_id: "org-suspended",
          org_name: "Suspended Org",
          org_slug: "suspended-org",
          suspended_at: "2026-02-01T00:00:00.000Z",
          suspended_reason: "Non-payment",
        },
        {
          role: "member",
          org_id: "org-healthy",
          org_name: "Healthy Org",
          org_slug: "healthy-org",
          suspended_at: null,
          suspended_reason: null,
        },
      ],
    });
    const req = createReq({
      authUser: { id: "user-4", email: "multi2@nia.dev" },
      withUser,
      cookie: "nia_active_org=org-healthy",
    });

    const next = await invoke(req, createRes());

    expect(next).toHaveBeenCalledWith();
    expect(req.actor).toEqual({
      userId: "user-4",
      email: "multi2@nia.dev",
      fullName: "Multi Org",
      org: { id: "org-healthy", name: "Healthy Org", slug: "healthy-org" },
      role: "member",
    });
  });

  it("org switcher: a missing/stale cookie falls back to the oldest membership (unchanged pre-switcher behaviour)", async () => {
    const withUser = createWithUser({
      profileRow: { full_name: "Multi Org" },
      membershipRows: [
        {
          role: "member",
          org_id: "org-oldest",
          org_name: "Oldest Org",
          org_slug: "oldest-org",
          suspended_at: null,
          suspended_reason: null,
        },
        {
          role: "admin",
          org_id: "org-newer",
          org_name: "Newer Org",
          org_slug: "newer-org",
          suspended_at: null,
          suspended_reason: null,
        },
      ],
    });
    const staleCookieReq = createReq({
      authUser: { id: "user-5", email: "multi3@nia.dev" },
      withUser,
      cookie: "nia_active_org=org-left-long-ago",
    });

    const next = await invoke(staleCookieReq, createRes());

    expect(next).toHaveBeenCalledWith();
    expect((staleCookieReq.actor as { org: { id: string } | null }).org).toEqual({
      id: "org-oldest",
      name: "Oldest Org",
      slug: "oldest-org",
    });
  });
});
