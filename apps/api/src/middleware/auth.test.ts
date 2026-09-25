import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

/**
 * docs/plans/auth.md Step 3's one required unit test: a valid session
 * resolves to the right user id; an invalid or expired one is rejected.
 * Covers both transports (bearer for requireAuth, cookie for
 * requireCookieAuth) since both are the one place identity is resolved.
 * auth.api.getSession itself is Better Auth's own, already-tested code —
 * mocked here at the module boundary, same convention as grants.test.ts.
 */
const getSession = vi.fn();
vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession } },
}));

const { requireAuth } = await import("./auth.js");
const { requireCookieAuth } = await import("./cookieAuth.js");

function createReq(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function createRes(): Response {
  return { setHeader: vi.fn() } as unknown as Response;
}

beforeEach(() => {
  getSession.mockReset();
});

describe("requireAuth (bearer)", () => {
  it("resolves a valid session to the right user id", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", email: "a@example.com" } });

    const req = createReq({ authorization: "Bearer good-token" });
    const next = vi.fn();
    await requireAuth(req, createRes(), next);

    expect(req.authUser).toEqual({ id: "user-1", email: "a@example.com" });
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects an invalid or expired session", async () => {
    getSession.mockResolvedValue(null);

    const req = createReq({ authorization: "Bearer bad-token" });
    const next = vi.fn();
    await requireAuth(req, createRes(), next);

    expect(req.authUser).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects a missing Authorization header without calling getSession", async () => {
    const req = createReq({});
    const next = vi.fn();
    await requireAuth(req, createRes(), next);

    expect(getSession).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

describe("requireCookieAuth (cookie)", () => {
  it("resolves a valid session to the right user id", async () => {
    getSession.mockResolvedValue({
      response: { user: { id: "user-2", email: "b@example.com" } },
      headers: new Headers(),
    });

    const req = createReq({ cookie: "better-auth.session_token=good" });
    const next = vi.fn();
    await requireCookieAuth(req, createRes(), next);

    expect(req.authUser).toEqual({ id: "user-2", email: "b@example.com" });
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects an invalid or expired session", async () => {
    getSession.mockResolvedValue({ response: null, headers: new Headers() });

    const req = createReq({ cookie: "better-auth.session_token=bad" });
    const next = vi.fn();
    await requireCookieAuth(req, createRes(), next);

    expect(req.authUser).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
