import { defineConfig } from "vitest/config";

// scripts/ is a plain folder (no package.json), so it's outside turbo's
// per-workspace-package task graph (see turbo.json) and `pnpm test` (turbo
// test) never reaches it. This root-level config gives it its own lean
// unit-test entry point (`pnpm scripts:test`), scoped to just that folder.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
