import { defineConfig } from "vitest/config";

// Scoped to lib/**: today that's only lib/canvas/mapping.ts's pure
// GraphDoc<->React Flow round-trip tests. Nothing here touches Next's App
// Router runtime, so no jsdom/next-test-env setup is needed yet — add one
// if/when a test needs to render a component.
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
  },
});
