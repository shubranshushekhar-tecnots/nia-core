import { defineConfig } from "vitest/config";

// Default (unit) config: `pnpm test` must be runnable with no Docker/live
// services, so a failing run always means a real regression, never "the
// SQL Server harness wasn't up." mssql.integration.test.ts intentionally
// exercises a real throwaway SQL Server container (scripts/harness/) and
// is excluded here — run it explicitly with `pnpm test:integration` once
// the harness is started (`scripts/harness/start.sh`). Same convention as
// apps/api/vitest.config.ts.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/mssql/mssql.integration.test.ts"],
  },
});
