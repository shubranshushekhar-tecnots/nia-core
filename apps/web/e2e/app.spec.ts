import { test, expect } from '@playwright/test';

// Mirrors auth.spec.ts's stance: no service-role key is available to apps/web
// by design, so a real, email-confirmed session can't be minted ad hoc by this
// suite. These tests cover everything reachable without one — the /app* route
// group's auth boundary — and document what's intentionally out of scope
// (see bottom of file).

test.describe('/app route group redirect boundary', () => {
  for (const path of ['/app', '/app/connections', '/app/billing']) {
    test(`unauthenticated user hitting ${path} is redirected to /login with ?next=`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/[/]/g, '%2F')}`));
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
  }
});

// Not covered here, and why:
//
// - "login -> /app greeting" and "sidebar create-project flow": both require
//   a real, email-confirmed Supabase auth session. Creating one from this
//   suite would mean inserting a persistent test user directly into the
//   shared remote auth.users table (the same technique rls_probes.sql uses,
//   but that script runs inside begin/rollback so nothing persists — a
//   Playwright storageState fixture needs the opposite, a session that
//   outlives the setup step). Doing that against the live project's
//   database is a call for whoever owns that database, not something to do
//   silently from a test file. Once a seeded, email-confirmed test account
//   is provisioned out-of-band (same precondition auth.spec.ts already
//   documents), both flows are straightforward Playwright additions:
//     * greeting: `expect(page.getByText(greetingForHour(new Date().getHours()))).toBeVisible()`
//       against HomeContent's `greetingStyle` span.
//     * create-project: open the sidebar's "New workflow" split button ->
//       "New project" -> fill CreateProjectDialog's name field -> submit ->
//       assert the new project row appears under the sidebar's Projects tree.
//
// - "theme toggle persistence": AppShell.tsx (the /app shell) is light-only
//   by design (`data-om-theme="light"`, no toggle control) — there is no
//   user-facing dark/light switch inside the app dashboard to test. The
//   dark/light toggle that exists on the auth screens is already covered by
//   auth.spec.ts's `theme toggle` describe block ([data-auth-theme]), which
//   is a separate, still-live feature.
