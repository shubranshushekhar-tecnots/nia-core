import { defineConfig } from "vitest/config";

// apps/worker/src/env.ts eagerly parses process.env at import time (so a
// misconfigured worker fails at boot, not on first job). Every test file
// that transitively imports env.ts (directly, or via connectorClient.ts)
// needs these to be present, even when the real DB/dispatch calls are
// mocked out — the module still has to import cleanly.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      NIA_SECRET_MASTER_KEY: "test-secret-master-key",
      WRITE_DISPATCH_SIGNING_SECRET: "test-write-dispatch-signing-secret-32b",
      NIA_GATEWAY_API_KEY: "test-gateway-key",
    },
  },
});
