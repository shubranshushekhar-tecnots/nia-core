import { test, expect } from '@playwright/test';
import { personas } from './fixtures/personas';
import { greetingForHour } from '../src/lib/time';

test.describe('/app route group redirect boundary', () => {
  for (const path of ['/app', '/app/connections', '/app/billing']) {
    test(`unauthenticated user hitting ${path} is redirected to /login with ?next=`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/[/]/g, '%2F')}`));
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
  }
});

test.describe('authenticated /app dashboard', () => {
  test.use({ storageState: personas.demo.storageStatePath });

  test('login -> /app shows the hour-based greeting', async ({ page }) => {
    await page.goto('/app');
    const greeting = greetingForHour(new Date().getHours());
    await expect(page.getByText(new RegExp(`^${greeting}`))).toBeVisible();
  });

  test('sidebar "New workflow" -> "New project" creates a project visible in the tree', async ({ page }) => {
    await page.goto('/app');

    const projectName = `E2E Project ${Date.now()}`;
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();

    await page.locator('#project-name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page.getByRole('link', { name: projectName })).toBeVisible();
  });
});

// Not covered here, and why:
//
// - "theme toggle persistence": AppShell.tsx (the /app shell) is light-only
//   by design (`data-om-theme="light"`, no toggle control) — there is no
//   user-facing dark/light switch inside the app dashboard to test. The
//   dark/light toggle that exists on the auth screens is already covered by
//   auth.spec.ts's `theme toggle` describe block ([data-auth-theme]), which
//   is a separate, still-live feature.
