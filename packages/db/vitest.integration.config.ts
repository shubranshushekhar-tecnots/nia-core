import { defineConfig } from "vitest/config";

// Integration config: exercises real local Postgres (`supabase start` —
// DATABASE_URL defaults to the local instance's direct connection, same
// role migrations use). Proves properties a mock can't: RLS actually
// isolating two real users, auth.uid()/role resolution, and connection
// state genuinely clearing on release. Kept out of the default `pnpm test`
// (vitest.config.ts) run so a failing unit suite always means a real
// regression, not "Postgres wasn't up." Run explicitly with
// `pnpm test:integration`.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 15_000,
  },
});
