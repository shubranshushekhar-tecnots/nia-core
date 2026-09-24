import { defineConfig } from "vitest/config";

// apps/api/src/env.ts eagerly parses process.env at import time (fail-fast
// on boot) — any test file that transitively imports env.ts (e.g. via
// lib/sse.ts) needs these present, same convention as apps/worker/vitest.config.ts.
//
// This is the default (unit) config: `pnpm test` must be runnable with no
// Docker/live services, so a failing run always means a real regression,
// never "Redis wasn't up." Tests that intentionally exercise a real local
// Redis (sse.replay.test.ts, checksQueue.timeout.test.ts — see their own
// header comments) are excluded here and live in vitest.integration.config.ts
// instead; run them explicitly with `pnpm test:integration` once
// docker-compose's `redis` service is up.
export default defineConfig({
  test: {
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "test-anon-key",
      WEB_ORIGIN: "http://localhost:3100",
      NIA_GATEWAY_API_KEY: "test-gateway-key",
      NIA_GATEWAY_BASE_URL: "https://api.nia.naslabs.ai/v1",
      NIA_GATEWAY_MODEL: "test-model",
      // Fixed 32-byte test key for @nia/secrets (docs/plans/secret-storage.md)
      // — never a real key, this is a fully public value used only so
      // env.ts's fail-fast parse succeeds in the unit suite.
      NIA_SECRET_MASTER_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    },
    testTimeout: 15_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/lib/sse.replay.test.ts",
      "src/lib/checksQueue.timeout.test.ts",
    ],
  },
});
