import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIError } from "better-auth/api";

// Email Phase 2 — lean coverage for the four new Server Actions, mirroring
// settings/actions.test.ts's mocking convention (mock the auth/mail seams,
// dynamic-import the module under test).

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// resetPasswordWithCode() redirects on success (apps/console/layout.test.ts's
// convention: mock redirect() to throw the same "NEXT_REDIRECT:<url>" shape
// Next's real implementation throws to unwind rendering).
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect }));

// actions.ts imports this for other actions (switchOrg, etc.) — real
// session.ts top-level calls React's cache() in a way this Vitest/React
// combo doesn't support, same reason settings/actions.test.ts mocks it.
vi.mock("@/lib/auth/session", () => ({
  ACTIVE_ORG_COOKIE: "nia_active_org",
  getSessionUser: vi.fn(),
}));

const sendVerificationOTP = vi.fn();
const signInEmailOTP = vi.fn();
const requestPasswordResetEmailOTP = vi.fn();
const resetPasswordEmailOTP = vi.fn();

vi.mock("@/lib/auth/auth", () => ({
  getAuth: () => ({
    api: {
      sendVerificationOTP: (...args: unknown[]) => sendVerificationOTP(...args),
      signInEmailOTP: (...args: unknown[]) => signInEmailOTP(...args),
      requestPasswordResetEmailOTP: (...args: unknown[]) => requestPasswordResetEmailOTP(...args),
      resetPasswordEmailOTP: (...args: unknown[]) => resetPasswordEmailOTP(...args),
    },
  }),
}));

// resetPasswordWithCode() deletes sessions via a direct SQL query (see its
// own comment in actions.ts for why it can't use better-auth's own
// /revoke-sessions endpoint) — same settings/actions.test.ts convention of
// stubbing getPool() down to just the `query` seam being exercised.
const query = vi.fn();
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: (...args: unknown[]) => query(...args) }) }));

const isAuthActionRateLimited = vi.fn();
vi.mock("@/lib/auth/rateLimit", () => ({
  isAuthActionRateLimited: (...args: unknown[]) => isAuthActionRateLimited(...args),
}));

const enqueueEmail = vi.fn();
vi.mock("@/lib/mail/mailQueue", () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args) }));

const {
  requestLoginCode,
  loginWithCode,
  requestPasswordReset,
  resetPasswordWithCode,
} = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  sendVerificationOTP.mockReset();
  signInEmailOTP.mockReset();
  requestPasswordResetEmailOTP.mockReset();
  resetPasswordEmailOTP.mockReset();
  query.mockReset();
  enqueueEmail.mockReset();
  redirect.mockClear();
  // Default: never rate-limited — each test that cares about the limited
  // path overrides this explicitly.
  isAuthActionRateLimited.mockReset();
  isAuthActionRateLimited.mockResolvedValue(false);
});

describe("requestLoginCode", () => {
  it("returns the generic message when the account exists", async () => {
    sendVerificationOTP.mockResolvedValue({ success: true });

    const result = await requestLoginCode(null, formData({ email: "real@example.com" }));

    expect(result?.message).toMatch(/if an account exists/i);
    expect(sendVerificationOTP).toHaveBeenCalledWith({
      body: { email: "real@example.com", type: "sign-in" },
    });
  });

  it("returns the identical generic message when the account does not exist (no-enumeration)", async () => {
    sendVerificationOTP.mockRejectedValue(new APIError("BAD_REQUEST", { message: "User not found" }));

    const result = await requestLoginCode(null, formData({ email: "ghost@example.com" }));

    expect(result?.message).toMatch(/if an account exists/i);
    expect(result?.error).toBeUndefined();
  });

  it("rejects an invalid email without calling better-auth", async () => {
    const result = await requestLoginCode(null, formData({ email: "not-an-email" }));

    expect(result?.fieldErrors?.email).toBeTruthy();
    expect(sendVerificationOTP).not.toHaveBeenCalled();
  });

  it("returns the same generic message when rate-limited, without sending a code", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const result = await requestLoginCode(null, formData({ email: "real@example.com" }));

    expect(result?.message).toMatch(/if an account exists/i);
    expect(sendVerificationOTP).not.toHaveBeenCalled();
  });
});

describe("requestPasswordReset", () => {
  it("returns the same generic message whether or not the account exists", async () => {
    requestPasswordResetEmailOTP.mockResolvedValueOnce({ success: true });
    const real = await requestPasswordReset(null, formData({ email: "real@example.com" }));

    requestPasswordResetEmailOTP.mockRejectedValueOnce(new APIError("BAD_REQUEST", { message: "User not found" }));
    const ghost = await requestPasswordReset(null, formData({ email: "ghost@example.com" }));

    expect(real?.message).toBe(ghost?.message);
    expect(real?.message).toMatch(/if an account exists/i);
  });

  it("returns the same generic message when rate-limited, without requesting a code", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const result = await requestPasswordReset(null, formData({ email: "real@example.com" }));

    expect(result?.message).toMatch(/if an account exists/i);
    expect(requestPasswordResetEmailOTP).not.toHaveBeenCalled();
  });
});

describe("loginWithCode", () => {
  it("returns a token on a valid code", async () => {
    signInEmailOTP.mockResolvedValue({ token: "tok-123", user: { id: "u1" } });

    const result = await loginWithCode(null, formData({ email: "a@example.com", otp: "123456" }));

    expect(result).toMatchObject({ success: true, token: "tok-123" });
  });

  it("returns a friendly error on an invalid/expired code", async () => {
    signInEmailOTP.mockRejectedValue(new APIError("BAD_REQUEST", { message: "Invalid OTP" }));

    const result = await loginWithCode(null, formData({ email: "a@example.com", otp: "000000" }));

    expect(result?.error).toMatch(/invalid or has expired/i);
  });

  it("returns the same invalid-code error when rate-limited, without checking the code", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const result = await loginWithCode(null, formData({ email: "a@example.com", otp: "123456" }));

    expect(result?.error).toMatch(/invalid or has expired/i);
    expect(signInEmailOTP).not.toHaveBeenCalled();
  });
});

describe("resetPasswordWithCode", () => {
  const validForm = () => formData({ email: "a@example.com", otp: "123456", password: "new-password-123" });

  it("resets the password, deletes every session for the account, emails a notice, and redirects to /login", async () => {
    resetPasswordEmailOTP.mockResolvedValue({ status: true });
    query.mockResolvedValue({ rowCount: 2 });

    await expect(resetPasswordWithCode(null, validForm())).rejects.toThrow(/NEXT_REDIRECT:\/login/);

    expect(resetPasswordEmailOTP).toHaveBeenCalledWith({
      body: { email: "a@example.com", otp: "123456", password: "new-password-123" },
    });
    // Every session for the account is deleted server-side — not scoped to
    // "other" sessions the way the old signInEmail+revokeOtherSessions
    // sequence was, and no new session is created in its place.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/delete from public\.session/i);
    expect(params).toEqual(["a@example.com"]);
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "send_email", to: "a@example.com", payload: expect.objectContaining({ template: "passwordChanged" }) }),
    );
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining("/login?message="));
  });

  it("returns a friendly error when the code is invalid, without deleting sessions or emailing", async () => {
    resetPasswordEmailOTP.mockRejectedValue(new APIError("BAD_REQUEST", { message: "Invalid OTP" }));

    const result = await resetPasswordWithCode(null, validForm());

    expect(result?.error).toMatch(/invalid or has expired/i);
    expect(query).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns the same invalid-code error when rate-limited, without checking the code", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const result = await resetPasswordWithCode(null, validForm());

    expect(result?.error).toMatch(/invalid or has expired/i);
    expect(resetPasswordEmailOTP).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
