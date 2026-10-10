import { afterAll, describe, expect, it } from "vitest";
import { auth } from "./auth.js";
import { dbPool } from "./dbPool.js";

/**
 * Email Phase 2 review fix: proves `emailOTP({ disableSignUp: true })`
 * (packages/auth/src/config.ts) actually blocks the real better-auth
 * route from creating an account — without that option, better-auth's own
 * signInEmailOTP handler silently calls `internalAdapter.createUser(...)`
 * for ANY email that completes the sign-in OTP flow, even one that never
 * signed up (see better-auth/dist/plugins/email-otp/routes.mjs). A mocked
 * unit test of our own Server Action (apps/web's actions.test.ts) can't
 * catch a regression here since it stubs `signInEmailOTP` entirely — this
 * has to run against the real plugin.
 *
 * `disableSignUp: true` also changes `sendVerificationOTP`'s own
 * behavior for an unknown email on `type: "sign-in"`: the route's
 * `shouldSendOTP = type === "sign-in" && !disableSignUp` becomes false,
 * so it deletes any stale verification row and returns success without
 * ever generating/storing an OTP — no code is created for an email with
 * no account, not just rejected at verify time.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

async function verificationRowExists(email: string): Promise<boolean> {
  const { rowCount } = await dbPool.query(
    'select 1 from public.verification where identifier = $1',
    [`sign-in-otp-${email}`],
  );
  return (rowCount ?? 0) > 0;
}

async function userExists(email: string): Promise<boolean> {
  const { rowCount } = await dbPool.query('select 1 from public."user" where email = $1', [email]);
  return (rowCount ?? 0) > 0;
}

describe("emailOTP disableSignUp — real better-auth plugin", () => {
  it("never generates a sign-in OTP for an email with no existing account, and signInEmailOTP creates no user", async () => {
    const ghostEmail = `ghost-emailotp-${Date.now()}@example.com`;
    expect(await userExists(ghostEmail)).toBe(false);

    await auth.api.sendVerificationOTP({ body: { email: ghostEmail, type: "sign-in" } });
    expect(await verificationRowExists(ghostEmail)).toBe(false);

    await expect(
      auth.api.signInEmailOTP({ body: { email: ghostEmail, otp: "000000" } }),
    ).rejects.toThrow();

    expect(await userExists(ghostEmail)).toBe(false);
  });
});
