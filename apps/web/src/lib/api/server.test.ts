import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Org switcher fix (Subscription Phase 2, Slice 1 follow-up): apiFetchServer
 * is a real server-to-server fetch (Node's own `fetch`, straight to
 * API_INTERNAL_URL) that never passes through Next's same-origin
 * /api/backend/:path* rewrite, so unlike a browser call, cookies aren't
 * attached automatically — see server.ts's own header comment. This proves
 * the explicit ACTIVE_ORG_COOKIE forward it added actually reaches the
 * outgoing request, using the same "two memberships, cookie set to the
 * newer org" scenario actor.test.ts already proves apps/api's attachActor
 * honors on the receiving end.
 */

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(), cookies: vi.fn() }));
vi.mock("better-auth/cookies", () => ({ getSessionCookie: vi.fn() }));
// session.ts's requireUser is wrapped in React's cache(), which throws
// outside the RSC runtime (see pickActiveMembership.ts's own extraction,
// done for the same reason) — server.ts only needs the ACTIVE_ORG_COOKIE
// constant from this module, so mock it at the boundary instead of
// pulling in cache()/getAuth()/getPool() transitively, same spirit as
// app/console/layout.test.ts mocking consoleServer.ts's pingConsole.
vi.mock("@/lib/auth/session", () => ({ ACTIVE_ORG_COOKIE: "nia_active_org" }));

const { headers, cookies } = await import("next/headers");
const { getSessionCookie } = await import("better-auth/cookies");
const { apiFetchServer } = await import("./server");

function fakeCookieStore(value: string | undefined) {
  return { get: (name: string) => (name === "nia_active_org" && value ? { name, value } : undefined) };
}

describe("apiFetchServer", () => {
  beforeEach(() => {
    vi.mocked(headers).mockResolvedValue(new Headers());
    vi.mocked(getSessionCookie).mockReturnValue("session-token-abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  it("acts in the org the caller switched to: with two memberships and the cookie set to the newer org, the outgoing request carries that org's cookie", async () => {
    // Two memberships exist for this user (org-oldest, org-newer); the
    // browser has already switched to org-newer, so ACTIVE_ORG_COOKIE
    // carries that id — not the oldest membership.
    vi.mocked(cookies).mockResolvedValue(fakeCookieStore("org-newer") as never);

    await apiFetchServer("/projects");

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const requestHeaders = init?.headers as Record<string, string>;
    expect(requestHeaders.Cookie).toBe("nia_active_org=org-newer");
    expect(requestHeaders.Authorization).toBe("Bearer session-token-abc");
  });

  it("omits the Cookie header when the caller has never switched orgs (no active-org cookie set)", async () => {
    vi.mocked(cookies).mockResolvedValue(fakeCookieStore(undefined) as never);

    await apiFetchServer("/projects");

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0]!;
    const requestHeaders = init?.headers as Record<string, string>;
    expect(requestHeaders.Cookie).toBeUndefined();
  });
});
