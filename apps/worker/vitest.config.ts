import { defineConfig } from "vitest/config";

// apps/worker/src/env.ts eagerly parses process.env at import time (so a
// misconfigured worker fails at boot, not on first job). Every test file
// that transitively imports env.ts (directly, or via supabaseClient.ts /
// connectorClient.ts) needs these to be present, even when the real
// Supabase client is mocked out — the module still has to import cleanly.
export default defineConfig({
  test: {
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      NIA_GATEWAY_API_KEY: "test-gateway-key",
    },
  },
});
