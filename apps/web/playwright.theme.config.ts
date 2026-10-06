import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'node:child_process';

const DEFAULT_PORT = process.env.PORT ?? '3100';

// Same probe as playwright.config.ts (see its header comment) — reuse an
// already-running `next dev` rather than spin up a second one against the
// same .next build cache.
function isAlreadyRunning(port: string): boolean {
  try {
    execSync(`curl -s -o /dev/null -m 2 http://localhost:${port}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const reusingRunningServer = isAlreadyRunning(DEFAULT_PORT);
const PORT = reusingRunningServer ? DEFAULT_PORT : '3178';
const BASE_URL = `http://localhost:${PORT}`;

// Dedicated, deliberately minimal config for themeConsistency.spec.ts only.
// That spec compares three fully public, unauthenticated pages (/login,
// /downloads, /docs/agent/getting-started) — it needs neither the main
// config's globalSetup (BullMQ worker + seeded DB personas, see
// e2e/globalSetup.ts) nor its "setup" project (persona logins via
// auth.setup.ts). Pulling in that overhead for a static theme/font check
// would be pure cost with no benefit, so this config omits both entirely.
export default defineConfig({
  testDir: './e2e',
  testMatch: /themeConsistency\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: reusingRunningServer
    ? undefined
    : {
        command: `next dev -p ${PORT}`,
        url: BASE_URL,
        env: { NEXT_DIST_DIR: '.next-theme-e2e' },
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
