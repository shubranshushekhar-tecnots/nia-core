import { defineConfig } from "vitest/config";
import path from "node:path";

// Resolve @nia/extract's subpath exports straight to source, not dist/ —
// same stale-dist footgun/fix as every other workspace test config (see
// CONVENTIONS.md). Subpath aliases must come before the bare "@nia/extract"
// entry: aliasing is matched by exact string, and each import specifier
// ("@nia/extract", "@nia/extract/mssql", "@nia/extract/testing") needs its
// own exact entry since a bare-package alias doesn't auto-extend to its
// subpaths.
export default defineConfig({
  resolve: {
    alias: {
      "@nia/extract/mssql": path.resolve(__dirname, "../../packages/extract/src/mssql/index.ts"),
      "@nia/extract/testing": path.resolve(__dirname, "../../packages/extract/src/testing/index.ts"),
      "@nia/extract": path.resolve(__dirname, "../../packages/extract/src/index.ts"),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
  },
});
