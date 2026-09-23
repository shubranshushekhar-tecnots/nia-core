import { defineConfig } from "vitest/config";
import path from "node:path";

// Scoped to lib/**: today that's only lib/canvas/mapping.ts's pure
// GraphDoc<->React Flow round-trip tests. Nothing here touches Next's App
// Router runtime, so no jsdom/next-test-env setup is needed yet — add one
// if/when a test needs to render a component.
export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path alias (Next's own
    // resolver honors tsconfig paths automatically; vitest doesn't, so any
    // module under src/lib/** that imports "@/..." at runtime — not just
    // in a type-only position — needs this to resolve outside Next.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/lib/**/*.test.ts"],
  },
});
