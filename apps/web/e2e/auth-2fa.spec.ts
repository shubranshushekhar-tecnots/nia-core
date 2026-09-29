import { test, expect } from '@playwright/test';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { generateTOTP } from './fixtures/totp';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

/**
 * Console v1 Slice 4 (docs/plans/console-plan.md §4b) — "2FA-enabled user
 * can sign in end to end; users without 2FA see no change."
 *
 * Uses a throwaway fixture user (not one of fixtures/personas.ts's shared
 * personas — enabling 2FA on a shared persona would break every other
 * spec's auth.setup.ts login for it). Enrollment goes entirely through the
 * real Better Auth API (auth.api.signUpEmail / enableTwoFactor /
 * verifyTOTP against a real pg.Pool, same pattern as apps/api's
 * seedFixtureUsers.ts) — never a raw SQL insert — matching this repo's
 * "no ad hoc session/account rows" convention (CONVENTIONS.md). `@nia/auth`
 * is ESM-only (no "require" export condition); dynamic import() is used
 * instead of a static import so this resolves correctly regardless of how
 * Playwright loads this file (see globalSetup.ts's comment on the same
 * issue for @nia/schemas, which affected static resolution there).
 *
 * better-auth's TOTP enrollment is two calls, not one: enableTwoFactor()
 * only creates an unverified two_factor row and returns the secret/backup
 * codes — user.twoFactorEnabled flips to true only after a first
 * successful verifyTOTP() (see better-auth's totp/index.mjs, the
 * `twoFactor.verified !== true` branch).
 *
 * The TOTP code generator (RFC 6238, Node's built-in crypto only) lives in
 * ./fixtures/totp.ts, shared with console-enroll.spec.ts.
 */

const TEST_EMAIL = 'auth-2fa-e2e@nia.dev';
const TEST_PASSWORD = 'password';

test.describe('login 2FA challenge', () => {
  test.describe.configure({ mode: 'serial' });

  let pool: Pool;
  let totpSecret: string;

  test.beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('auth-2fa.spec.ts: DATABASE_URL is missing (apps/web/.env.local).');
    }
    pool = new Pool({ connectionString });
    // Idempotent re-run: drop any leftover fixture from a prior aborted run.
    await pool.query('delete from "user" where email = $1', [TEST_EMAIL]);

    const { createAuth } = await import('@nia/auth');
    const auth = createAuth(pool, {
      baseURL: process.env.SITE_URL ?? 'http://localhost:3100',
      secret: process.env.BETTER_AUTH_SECRET!,
    });

    const signUp = await auth.api.signUpEmail({
      body: { email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Auth 2FA E2E' },
    });
    const bearerHeaders = new Headers({ authorization: `Bearer ${signUp.token}` });

    const enabled = await auth.api.enableTwoFactor({
      body: { password: TEST_PASSWORD },
      headers: bearerHeaders,
    });
    if (enabled.method !== 'totp' || !enabled.totpURI) {
      throw new Error(`auth-2fa.spec.ts: expected a TOTP enable response, got ${JSON.stringify(enabled)}`);
    }
    const secretMatch = /[?&]secret=([^&]+)/.exec(enabled.totpURI);
    if (!secretMatch?.[1]) throw new Error(`auth-2fa.spec.ts: could not parse secret from totpURI: ${enabled.totpURI}`);
    totpSecret = decodeURIComponent(secretMatch[1]);

    // Completes enrollment — user.twoFactorEnabled only flips true here.
    await auth.api.verifyTOTP({
      body: { code: generateTOTP(totpSecret) },
      headers: bearerHeaders,
    });
  });

  test.afterAll(async () => {
    await pool.query('delete from "user" where email = $1', [TEST_EMAIL]);
    await pool.end();
  });

  test('2FA-enabled user is challenged for a code and can sign in with it', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(TEST_EMAIL);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();

    await page.locator('#code').fill(generateTOTP(totpSecret));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();

    await expect(page).toHaveURL(/\/app/);
  });

  test('user without 2FA sees no change (plain login, no code step)', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('demo@nia.dev');
    await page.locator('#password').fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/app/);
  });
});
