import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Console v1 Slice 1 review fix (docs/plans/console-plan.md): proves
 * ConsoleLayout treats a 403 ApiError (authenticated, not staff), a 404
 * ApiError (CONSOLE_ENABLED=false, router not mounted), a 5xx ApiError, and
 * a non-ApiError transport failure all the same way from the visitor's
 * perspective — every case calls notFound(), so the console's existence is
 * never revealed to a caller, staff or not, and an outage never surfaces as
 * a 500 error page. The 5xx and transport-failure cases are also expected
 * to log server-side (console.error) so an apps/api outage stays visible
 * to the team even though the visitor only ever sees a 404 — the 403/404
 * cases must NOT log, since those are normal, expected access-control
 * results, not outages. ConsoleLayout is a plain async function (no JSX of
 * its own beyond returning `children` verbatim), so it's called directly
 * here rather than rendered — no jsdom/React-testing-library needed.
 *
 * next/navigation's notFound() is mocked to throw, matching its real
 * behavior (it throws a special NEXT_NOT_FOUND error to unwind rendering).
 */

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ notFound, redirect }));

const pingConsole = vi.fn();
vi.mock("@/lib/api/consoleServer", () => ({ pingConsole }));

// Org switcher fix: @/lib/api/server now imports ACTIVE_ORG_COOKIE from
// @/lib/auth/session, whose requireUser is wrapped in React's cache() —
// that throws outside the RSC runtime (see pickActiveMembership.ts's own
// extraction, done for the same reason), so this module boundary is
// mocked here too, same spirit as pingConsole above.
vi.mock("@/lib/auth/session", () => ({ ACTIVE_ORG_COOKIE: "nia_active_org" }));

const { ApiError } = await import("@/lib/api/server");
const { default: ConsoleLayout } = await import("./layout");

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  notFound.mockClear();
  redirect.mockClear();
  pingConsole.mockReset();
  consoleErrorSpy.mockClear();
});

describe("ConsoleLayout", () => {
  it("renders children when pingConsole resolves (staff session, flag on)", async () => {
    pingConsole.mockResolvedValue(undefined);

    const children = "console content";
    const result = await ConsoleLayout({ children: children as unknown as React.ReactNode });

    expect(result).toBe(children);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("renders notFound() for a 403 ApiError (authenticated but not staff) without logging", async () => {
    pingConsole.mockRejectedValue(new ApiError(403, "NOT_STAFF", "Not staff."));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("renders notFound() for a 404 ApiError (CONSOLE_ENABLED=false, router not mounted) without logging", async () => {
    pingConsole.mockRejectedValue(new ApiError(404, "NOT_FOUND", "Not found."));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("renders notFound() and logs server-side for a 5xx ApiError (apps/api outage)", async () => {
    pingConsole.mockRejectedValue(new ApiError(503, "UNAVAILABLE", "Service unavailable."));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("renders notFound() and logs server-side for a non-ApiError transport failure (apps/api unreachable)", async () => {
    pingConsole.mockRejectedValue(new Error("fetch failed"));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("redirects to /console-enroll for a STAFF_2FA_REQUIRED ApiError without logging", async () => {
    pingConsole.mockRejectedValue(new ApiError(403, "STAFF_2FA_REQUIRED", "Staff must complete 2FA."));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/console-enroll");
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith("/console-enroll");
    expect(notFound).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("redirects to /login for a STAFF_SESSION_EXPIRED ApiError without logging", async () => {
    pingConsole.mockRejectedValue(new ApiError(403, "STAFF_SESSION_EXPIRED", "Staff session has expired."));

    await expect(ConsoleLayout({ children: null })).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(notFound).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
