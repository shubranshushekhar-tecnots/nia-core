import { test as setup, expect } from '@playwright/test';
import { personas } from './fixtures/personas';

/**
 * Playwright "setup" project (see playwright.config.ts): signs in each
 * persona through the real /login form against local Supabase and saves
 * the resulting session cookies to storageState. Runs once per test run,
 * before the main `chromium` project (which `dependencies: ['setup']` on).
 *
 * Real login, not a manufactured session — proves the actual auth flow
 * works for every persona shape (org member, other-org owner, org-less
 * personal workspace), and gives every other spec a ready-made
 * authenticated context via `test.use({ storageState: ... })`.
 */
for (const persona of Object.values(personas)) {
  setup(`authenticate as ${persona.email}`, async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(persona.email);
    await page.locator('#password').fill(persona.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/app/);
    await page.context().storageState({ path: persona.storageStatePath });
  });
}
