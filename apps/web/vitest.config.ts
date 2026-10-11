import { defineConfig } from "vitest/config";
import path from "node:path";

// Scoped to lib/** plus a handful of app/** and components/** server-safe,
// plain-function, non-JSX files, plus a small set of .test.tsx files that
// actually render canvas components under jsdom (Agent-delivered-workflow
// polish pass, see docs/plans/agent-canvas-integration.md): today that's
// lib/canvas/mapping.ts's pure GraphDoc<->React Flow round-trip tests,
// app/console/layout.test.ts, navGroups.test.ts (Slice 10), and
// components/canvas/*.test.tsx. This project's Vite (8.x) uses the
// Rolldown/oxc transform pipeline, not classic esbuild, so the usual
// `esbuild.jsx` option is silently ignored (oxc wins and esbuild options
// are dropped) — the equivalent oxc option below is required instead, since
// it otherwise inherits tsconfig.json's "jsx": "preserve" (Next's own
// setting, for its downstream compiler) and errors on raw JSX without it.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
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
      // More specific subpath entries must come before the bare "@nia/schemas"
      // entry below — Vite's alias matching is a prefix match (same mechanism
      // that makes "@" above match "@/foo"), so "@nia/schemas" alone would
      // also swallow "@nia/schemas/downloadManifest" and mangle it into an
      // invalid path if it were listed first.
      "@nia/schemas/downloadManifest": path.resolve(__dirname, "../../packages/schemas/src/downloadManifest.ts"),
      "@nia/schemas": path.resolve(__dirname, "../../packages/schemas/src/index.ts"),
      "@nia/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
      "@nia/auth": path.resolve(__dirname, "../../packages/auth/src/index.ts"),
    },
  },
  test: {
    include: [
      "src/lib/**/*.test.ts",
      "src/app/console/**/*.test.ts",
      "src/app/api/**/*.test.ts",
      "src/components/console/**/*.test.ts",
      "src/components/canvas/**/*.test.tsx",
    ],
    // `environmentMatchGlobs` (older Vitest) doesn't exist in this project's
    // Vitest 5 — there's no per-glob environment switch anymore, so the
    // whole suite runs under jsdom. The plain .ts files above are pure
    // function calls with no Node-only API conflicts, so this is safe.
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
