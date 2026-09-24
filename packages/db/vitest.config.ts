import { defineConfig } from "vitest/config";

// Default (unit) config: no real Postgres involved — mocked pg.Pool only.
// `pnpm test` must be runnable with no local Supabase/Postgres running, so
// a failing run here always means a real regression. The properties that
// need real Postgres (RLS isolation, role/claim resolution, connection
// state cleared on release) live in client.integration.test.ts instead —
// run explicitly with `pnpm test:integration` once `supabase start` is up.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
  },
});
