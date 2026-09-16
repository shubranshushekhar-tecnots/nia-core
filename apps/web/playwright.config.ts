import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT ?? '3100';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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
