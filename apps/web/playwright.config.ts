import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT ?? '3100';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Fails fast with a pointed message if apps/worker isn't running or
  // canvasC's seeded connections are missing — see globalSetup.ts's header
  // comment. Runs once, before the "setup" project's persona logins.
  globalSetup: './e2e/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Pinned to 1 (not left to Playwright's CPU-based default) after Phase 5
  // Session 3 Task 2's e2e hardening pass found canvas.spec.ts's
  // gotoWorkflow navigation intermittently timing out under 4 concurrent
  // workers — root-caused to resource contention against the single
  // `next dev` webServer this config spins up (see the webServer block
  // below), not a product bug: the same suite passes reliably, faster per
  // test, at workers:1. Playwright has no true per-project worker cap (the
  // `projects` array only varies browser/testMatch/fullyParallel, not
  // concurrency), and every project here shares that one dev server, so
  // this is pinned globally rather than just for canvas.spec.ts/
  // chat.spec.ts specifically — scoping it to "the heavy tests" would
  // still contend with whatever else is running concurrently. Revisit if
  // the webServer is ever split per-project or CI gets a dedicated runner
  // per shard.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    // fullyParallel: false — all 4 persona logins live in one file
    // (auth.setup.ts) and hit local Supabase GoTrue's sign-in rate limit
    // when run concurrently; this keeps them sequential within that file.
    { name: 'setup', testMatch: /.*\.setup\.ts/, fullyParallel: false },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
