import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration config: mirrors packages/extract's vitest.integration.config.ts.
// Runs apps/agent's end-to-end tests against the real throwaway SQL Server
// harness (packages/extract/scripts/harness) + this package's own fake
// Planometry push server — no mocks on either side. Kept out of the default
// `pnpm test` run (vitest.config.ts), same reasoning as every other
// package's split: a failing unit suite should always mean a real
// regression, not "the harness wasn't started." Run explicitly with
// `pnpm test:integration` after `packages/extract/scripts/harness/start.sh`.
export default defineConfig({
  resolve: {
    alias: {
      "@nia/extract/mssql": path.resolve(__dirname, "../../packages/extract/src/mssql/index.ts"),
      "@nia/extract/testing": path.resolve(__dirname, "../../packages/extract/src/testing/index.ts"),
      "@nia/extract": path.resolve(__dirname, "../../packages/extract/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
