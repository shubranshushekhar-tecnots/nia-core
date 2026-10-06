import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';

const DEFAULT_PORT = process.env.PORT ?? '3100';

/**
 * True when something is already answering on the project's standard dev
 * port. A plain TCP/HTTP probe (not Nia IDE's own dev-server tracking API
 * — this config has to work for any caller, not just inside that IDE) —
 * `curl`'s own connect timeout keeps this bounded even if the port is
 * firewalled rather than simply closed.
 */
function isAlreadyRunning(port: string): boolean {
  try {
    execSync(`curl -s -o /dev/null -m 2 http://localhost:${port}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A `next dev` process already running on the standard port owns
// apps/web/.next's build cache; starting a second `next dev` against that
// same folder (even on a different port) corrupts it — two processes
// writing the same on-disk build concurrently. So: reuse that server
// as-is when one is running (no webServer block at all — Playwright just
// points baseURL at it); otherwise build Playwright's own, on a different
// port AND a different distDir (next.config.mjs's NEXT_DIST_DIR), so it
// can never collide with that shared folder even if the other server
// starts later.
const reusingRunningServer = isAlreadyRunning(DEFAULT_PORT);
const PORT = reusingRunningServer ? DEFAULT_PORT : '3177';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // themeConsistency.spec.ts has its own dedicated, lighter config
  // (playwright.theme.config.ts) — it only touches public/signed-out
  // pages and deliberately skips this config's globalSetup/`setup`
  // project overhead, so exclude it here to avoid requiring that infra
  // for a static theme/font check.
  testIgnore: /themeConsistency\.spec\.ts/,
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
  // Omitted entirely when reusing an already-running server — see
  // `reusingRunningServer` above. Playwright treats a missing webServer as
  // "assume baseURL is already serving," which is exactly what's wanted
  // here.
  webServer: reusingRunningServer
    ? undefined
    : {
        command: `next dev -p ${PORT}`,
        url: BASE_URL,
        env: { NEXT_DIST_DIR: '.next-e2e' },
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
