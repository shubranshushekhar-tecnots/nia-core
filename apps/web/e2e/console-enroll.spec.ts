import { test, expect } from '@playwright/test';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { generateTOTP } from './fixtures/totp';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

/**
 * Console v1 Slice 4 (docs/plans/console-plan.md §4b) — plan item #2:
 * "a newly enrolled staff member can reach the Console without looping."
 *
 * Grants platform_staff to a throwaway fixture user (never twoFactorEnabled
 * yet), then drives the real /console-enroll screen end to end: password
 * confirm -> scan/verify -> land on /console. Proves the layout.tsx redirect
 * (STAFF_2FA_REQUIRED -> /console-enroll) and the enroll screen's own
 * post-verify navigation don't bounce the user back to /console-enroll
 * again (the "looping" failure mode plan item #2 calls out).
 *
 * Same fixture-user rationale as auth-2fa.spec.ts (not a shared persona —
 * granting staff + enabling 2FA on a shared persona would break other
 * specs' auth.setup.ts login for it). platform_staff is granted via a
 * direct insert, matching manageStaff's own integration-test convention
 * (apps/api/src/scripts/manageStaff.resetTwoFactor.integration.test.ts)
 * rather than shelling out to the CLI.
 */

const TEST_EMAIL = 'console-enroll-e2e@nia.dev';
const TEST_PASSWORD = 'password';

test.describe('console enroll screen', () => {
  test.describe.configure({ mode: 'serial' });

  let pool: Pool;
  let userId: string;

  test.beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('console-enroll.spec.ts: DATABASE_URL is missing (apps/web/.env.local).');
    }
    pool = new Pool({ connectionString });

    // Idempotent re-run: reset any leftover fixture from a prior run rather
    // than deleting the user row outright. staff_audit_log
    // (0040_staff_audit_log.sql) is append-only by design — a BEFORE
    // UPDATE OR DELETE trigger unconditionally rejects mutation, for every
    // role including the table owner — so once this fixture user has hit
    // any staff_audit_log-writing route even once, `delete from "user"`
    // fails forever on its staff_audit_log_staff_user_id_fkey FK. Resetting
    // 2FA/staff state in place (session + twoFactor rows cascade-delete via
    // their own userId FKs; platform_staff and user itself don't) keeps the
    // test idempotent without ever touching staff_audit_log.
    const existing = await pool.query('select id from "user" where email = $1', [TEST_EMAIL]);
    if (existing.rowCount) {
      userId = existing.rows[0].id;
      await pool.query('delete from public.session where "userId" = $1', [userId]);
      await pool.query('delete from public."twoFactor" where "userId" = $1', [userId]);
      await pool.query('delete from public.platform_staff where user_id = $1', [userId]);
      await pool.query('update public."user" set "twoFactorEnabled" = false where id = $1', [userId]);
    }

    const { createAuth } = await import('@nia/auth');
    const auth = createAuth(pool, {
      baseURL: process.env.SITE_URL ?? 'http://localhost:3100',
      secret: process.env.BETTER_AUTH_SECRET!,
    });

    if (!existing.rowCount) {
      const signUp = await auth.api.signUpEmail({
        body: { email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Console Enroll E2E' },
      });
      userId = signUp.user.id;
    }

    await pool.query(
      `insert into public.platform_staff (user_id, granted_by, granted_at) values ($1, $1, now())`,
      [userId],
    );
  });

  test.afterAll(async () => {
    await pool.query('delete from public.platform_staff where user_id = $1', [userId]);
    await pool.end();
  });

  test('a newly enrolled staff member reaches /console without looping', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(TEST_EMAIL);
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/app/);

    // Not yet 2FA-enrolled: requireStaff.ts throws STAFF_2FA_REQUIRED,
    // console/layout.tsx redirects here instead of the generic 404.
    await page.goto('/console');
    await expect(page).toHaveURL(/\/console-enroll/);

    await expect(page.getByRole('heading', { name: 'Set up two-factor' })).toBeVisible();
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Scan the code' })).toBeVisible();
    const secret = await page.getByText('Manual entry key:').locator('span').innerText();
    expect(secret.length).toBeGreaterThan(0);

    await page.locator('#code').fill(generateTOTP(secret));
    await page.getByRole('button', { name: 'Verify and continue', exact: true }).click();

    // Lands on /console with no bounce back to /console-enroll.
    await expect(page).toHaveURL(/\/console$/);
    await expect(page).not.toHaveURL(/\/console-enroll/);
  });
});
