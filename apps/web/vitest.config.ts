import { defineConfig } from "vitest/config";
import path from "node:path";

// Scoped to lib/** plus a handful of app/** server-only files (see below):
// today that's lib/canvas/mapping.ts's pure GraphDoc<->React Flow
// round-trip tests, plus app/console/layout.test.ts. Nothing here touches
// Next's App Router rendering — app/console/layout.tsx is a plain async
// function called directly, not rendered — so no jsdom/next-test-env setup
// is needed yet; add one if/when a test needs to actually render a
// component.
export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path alias (Next's own
    // resolver honors tsconfig paths automatically; vitest doesn't, so any
    // module under src/lib/** that imports "@/..." at runtime — not just
    // in a type-only position — needs this to resolve outside Next.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/lib/**/*.test.ts", "src/app/console/**/*.test.ts"],
  },
});
