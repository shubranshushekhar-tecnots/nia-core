import { defineConfig } from "vitest/config";

// Integration config: tests here deliberately exercise a real local service
// instead of mocking it — sse.replay.test.ts/checksQueue.timeout.test.ts
// need real Redis (docker-compose's `redis` service), and
// manageStaff.atomicity.integration.test.ts needs real local Postgres
// (apps/api/.env's DATABASE_URL) to prove withTransaction's rollback
// behavior, which a mock can't meaningfully stand in for either way. Kept
// out of the default `pnpm test` (vitest.config.ts) run so a failing unit
// suite always means a real regression, not "Redis/Postgres wasn't up."
// Run explicitly with `pnpm test:integration`.
export default defineConfig({
  test: {
    include: [
      "src/lib/sse.replay.test.ts",
      "src/lib/checksQueue.timeout.test.ts",
      "src/scripts/manageStaff.atomicity.integration.test.ts",
    ],
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "test-anon-key",
      WEB_ORIGIN: "http://localhost:3100",
      NIA_SECRET_MASTER_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    },
    testTimeout: 15_000,
  },
});
