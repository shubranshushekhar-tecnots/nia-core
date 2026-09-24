import { defineConfig } from "vitest/config";

// Integration config: tests here deliberately exercise a real local Redis
// (docker-compose's `redis` service — `docker compose up -d redis`) instead
// of mocking ioredis, since what they're regression-testing is real
// subscribe/LRANGE/PUBLISH ordering and BullMQ's waitUntilFinished timeout
// behavior, which a mock can't meaningfully stand in for. Kept out of the
// default `pnpm test` (vitest.config.ts) run so a failing unit suite always
// means a real regression, not "Redis wasn't up." Run explicitly with
// `pnpm test:integration`.
export default defineConfig({
  test: {
    include: ["src/lib/sse.replay.test.ts", "src/lib/checksQueue.timeout.test.ts"],
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "test-anon-key",
      WEB_ORIGIN: "http://localhost:3100",
      NIA_SECRET_MASTER_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    },
    testTimeout: 15_000,
  },
});
