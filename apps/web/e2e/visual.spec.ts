import { test, expect } from '@playwright/test';

// Visual regression harness, 1440px viewport. Uses Playwright's built-in
// screenshot diffing (no extra deps): the first run writes a baseline PNG
// under e2e/visual.spec.ts-snapshots/, every run after that fails if the
// rendered page drifts from it by more than Playwright's default pixel
// threshold. Commit the generated baselines so CI enforces them.
//
// Scope note: this covers the publicly reachable /login and /signup screens,
// which are real, live-rendered pages today. It deliberately does NOT diff
// against designs/*.html directly, for two independent reasons:
//
//   1. designs/Nia Core App.html is a "Bundled Page" export (see its own
//      <title>) that renders only a placeholder loading thumbnail offline —
//      the actual design content is lazy-loaded at view time from
//      internet-hosted asset UUIDs via a <script src="..."> tag the export
//      references but doesn't inline. Opening it via file:// (or any static
//      server) never produces the real layout, so there's no pixel-accurate
//      reference image on disk to diff against.
//   2. The /app home screen itself requires a real, logged-in session.
//      Without one, /app redirects to /login before anything is rendered.
//
// Once either constraint is lifted (a static PNG/JPEG export of the design
// is provided, and/or a seeded test account exists), add a case here the
// same shape as the two below: `page.goto('/app')` (with a storageState
// fixture for the seeded account) + `toHaveScreenshot('app-home-1440.png')`.

// Root cause of this suite's historical flakiness (Phase 5 Session 5 exit
// review, confirmed by diffing actual screenshots pixel-for-pixel): these
// tests run against `next dev` (per this repo's standard workflow — see
// root CONVENTIONS.md), and Next's dev-mode build-activity indicator
// (<nextjs-portal>, bottom-left corner) pops in/out depending on
// background compile state at the exact moment the screenshot is taken —
// nothing to do with real page content. It's a debug-only overlay, never
// part of the page's actual visual contract, so hide it before every
// screenshot in this file rather than let it leak into the diff.
async function hideNextDevIndicator(page: import('@playwright/test').Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

test.describe('visual regression (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('/login matches baseline', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await hideNextDevIndicator(page);
    await expect(page).toHaveScreenshot('login-1440.png', { fullPage: true });
  });

  test('/signup matches baseline', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await hideNextDevIndicator(page);
    await expect(page).toHaveScreenshot('signup-1440.png', { fullPage: true });
  });
});
