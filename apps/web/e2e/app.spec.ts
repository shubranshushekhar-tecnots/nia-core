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

  test('"New project" on the Projects page creates a project visible in the sidebar tree', async ({ page }) => {
    // The old "New workflow" dashboard button (and the sidebar's "New"
    // dropdown it opened) no longer exist — the home-dashboard redesign
    // (commit 3040260) removed them; Sidebar.tsx's own showCreateWorkflow
    // state is dead code today. "New project" now lives on the Projects
    // page itself (ProjectsListClient.tsx).
    await page.goto('/app/projects');

    const projectName = `E2E Project ${Date.now()}`;
    // exact:true: the sidebar's own "+ New project" button (Sidebar.tsx) is
    // also on screen (navProjectsOpen defaults true) and its accessible name
    // contains "New project" as a substring — an unscoped match resolves to
    // both buttons.
    await page.getByRole('button', { name: 'New project', exact: true }).click();

    await page.locator('#project-name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();

    // exact:true: the Projects list's own row link additionally contains
    // the workflow count and a nested "Delete" button in its accessible
    // name, so an unscoped match would resolve to two elements (this row +
    // the sidebar's tree row) — exact narrows to the sidebar's link, whose
    // accessible name is just the project name (chevron is aria-hidden).
    await expect(page.getByRole('link', { name: projectName, exact: true })).toBeVisible();
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
