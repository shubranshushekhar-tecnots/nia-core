import { defineConfig } from "vitest/config";
import path from "node:path";

// apps/worker/src/env.ts eagerly parses process.env at import time (so a
// misconfigured worker fails at boot, not on first job). Every test file
// that transitively imports env.ts (directly, or via connectorClient.ts)
// needs these to be present, even when the real DB/dispatch calls are
// mocked out — the module still has to import cleanly.
export default defineConfig({
  // Resolve @nia/* straight to src/index.ts, not dist/index.js — same
  // stale-dist footgun/fix as apps/api/vitest.config.ts, see there and
  // CONVENTIONS.md.
  resolve: {
    alias: {
      "@nia/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      "@nia/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      "@nia/guardrails": path.resolve(__dirname, "../../packages/guardrails/src/index.ts"),
      "@nia/secrets": path.resolve(__dirname, "../../packages/secrets/src/index.ts"),
    },
  },
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      NIA_SECRET_MASTER_KEY: "test-secret-master-key",
      WRITE_DISPATCH_SIGNING_SECRET: "test-write-dispatch-signing-secret-32b",
      NIA_GATEWAY_API_KEY: "test-gateway-key",
    },
    // Real-Postgres tests are excluded here, same convention as
    // apps/api/vitest.config.ts — run them explicitly with
    // `pnpm test:integration` (vitest.integration.config.ts) once local
    // Postgres is up.
    exclude: ["**/node_modules/**", "**/dist/**", "src/lib/etl/workflowRuns.integration.test.ts"],
  },
});
