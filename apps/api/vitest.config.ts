import { defineConfig } from "vitest/config";
import path from "node:path";

// apps/api/src/env.ts eagerly parses process.env at import time (fail-fast
// on boot) — any test file that transitively imports env.ts (e.g. via
// lib/sse.ts) needs these present, same convention as apps/worker/vitest.config.ts.
//
// This is the default (unit) config: `pnpm test` must be runnable with no
// Docker/live services, so a failing run always means a real regression,
// never "Redis/Postgres wasn't up." Tests that intentionally exercise a
// real local service (sse.replay.test.ts/checksQueue.timeout.test.ts need
// Redis; manageStaff.atomicity.integration.test.ts needs Postgres — see
// their own header comments) are excluded here and live in
// vitest.integration.config.ts instead; run them explicitly with
// `pnpm test:integration` once the needed service is up.
//
// resolve.alias below points every @nia/* import straight at its
// src/index.ts instead of dist/index.js: turbo's `test` task depends on
// `^build` (turbo.json), but a direct `vitest run`/`pnpm --filter @nia/api
// test` bypasses turbo and can silently run against yesterday's dist —
// bit us for real once (packages/schemas's grants.* RBAC matrix, Slice 5).
// See CONVENTIONS.md.
export default defineConfig({
  resolve: {
    alias: {
      "@nia/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      "@nia/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      "@nia/auth": path.resolve(__dirname, "../../packages/auth/src/index.ts"),
      "@nia/guardrails": path.resolve(__dirname, "../../packages/guardrails/src/index.ts"),
      "@nia/secrets": path.resolve(__dirname, "../../packages/secrets/src/index.ts"),
    },
  },
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
      "src/scripts/manageStaff.atomicity.integration.test.ts",
      "src/scripts/manageStaff.resetTwoFactor.integration.test.ts",
    ],
  },
});
