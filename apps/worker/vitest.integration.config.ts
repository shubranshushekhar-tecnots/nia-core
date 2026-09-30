import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration config: mirrors apps/api's vitest.integration.config.ts.
// workflowRuns.integration.test.ts needs real local Postgres (apps/worker's
// own .env DATABASE_URL, loaded via env.ts's `import "dotenv/config"`) to
// prove finishRun's usage_events insert is idempotent under a real unique
// constraint — a mock can't meaningfully stand in for that. Kept out of the
// default `pnpm test` (vitest.config.ts) run, which deliberately points
// DATABASE_URL at a fake host so a failing unit suite always means a real
// regression, not "Postgres wasn't up." Run explicitly with
// `pnpm test:integration`.
export default defineConfig({
  resolve: {
    alias: {
      "@nia/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      "@nia/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      "@nia/guardrails": path.resolve(__dirname, "../../packages/guardrails/src/index.ts"),
      "@nia/secrets": path.resolve(__dirname, "../../packages/secrets/src/index.ts"),
    },
  },
  test: {
    include: ["src/lib/etl/workflowRuns.integration.test.ts"],
    testTimeout: 15_000,
  },
});
