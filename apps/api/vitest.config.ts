import { defineConfig } from "vitest/config";

// apps/api/src/env.ts eagerly parses process.env at import time (fail-fast
// on boot) — any test file that transitively imports env.ts (e.g. via
// lib/sse.ts) needs these present, same convention as apps/worker/vitest.config.ts.
export default defineConfig({
  test: {
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "test-anon-key",
      WEB_ORIGIN: "http://localhost:3100",
    },
    testTimeout: 15_000,
  },
});
