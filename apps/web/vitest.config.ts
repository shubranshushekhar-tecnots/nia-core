import { defineConfig } from "vitest/config";
import path from "node:path";

// Scoped to lib/** plus a handful of app/** and components/** server-safe,
// plain-function, non-JSX files (see below): today that's
// lib/canvas/mapping.ts's pure GraphDoc<->React Flow round-trip tests,
// app/console/layout.test.ts, and navGroups.test.ts (Slice 10). Nothing
// here touches Next's App Router rendering or JSX — every file above is a
// plain function in a .ts (not .tsx) module called directly, not rendered
// — so no jsdom/next-test-env setup is needed yet; add one if/when a test
// needs to actually render a component (tsconfig.json's "jsx": "preserve"
// means vite's default esbuild transform can't parse a .tsx file anyway,
// so keep test-covered logic that doesn't need JSX in plain .ts modules).
export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path alias (Next's own
    // resolver honors tsconfig paths automatically; vitest doesn't, so any
    // module under src/lib/** that imports "@/..." at runtime — not just
    // in a type-only position — needs this to resolve outside Next.
    //
    // The @nia/* entries resolve straight to src/index.ts instead of
    // dist/index.js — same stale-dist footgun/fix as apps/api/vitest.config.ts,
    // see there and CONVENTIONS.md.
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@nia/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      "@nia/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      "@nia/auth": path.resolve(__dirname, "../../packages/auth/src/index.ts"),
    },
  },
  test: {
    include: ["src/lib/**/*.test.ts", "src/app/console/**/*.test.ts", "src/components/console/**/*.test.ts"],
  },
});
