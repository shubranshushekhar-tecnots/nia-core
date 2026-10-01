import { defineConfig } from "vitest/config";

// Default (unit) config: `pnpm test` must be runnable with no Docker/live
// services, so a failing run always means a real regression, never "the
// SQL Server harness wasn't up." mssql.integration.test.ts and
// legacyTls.integration.test.ts intentionally exercise real throwaway SQL
// Server containers (scripts/harness/) and are excluded here — run them
// explicitly with `pnpm test:integration` once the relevant harness is
// started (`scripts/harness/start.sh` / `start-legacy-tls.sh`). Same
// convention as apps/api/vitest.config.ts.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/mssql/mssql.integration.test.ts",
      "src/mssql/legacyTls.integration.test.ts",
    ],
  },
});
