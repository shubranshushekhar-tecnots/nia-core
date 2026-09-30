import { defineConfig } from "vitest/config";

// Integration config: tests here deliberately exercise a real local service
// instead of mocking it — sse.replay.test.ts/checksQueue.timeout.test.ts
// need real Redis (docker-compose's `redis` service), and
// manageStaff.atomicity.integration.test.ts/staffAudit.integration.test.ts/
// orgPlan.integration.test.ts/dashboard.integration.test.ts need real local
// Postgres (apps/api/.env's DATABASE_URL) to prove withTransaction's
// rollback behavior, the real withServiceRole grant path, the
// 0042_org_plan.sql backfill's exactness, and getOrgPlan's real RLS-scoped
// (0044_org_plan_member_select.sql) read path respectively — neither a mock
// can meaningfully stand in for any of these. workflowLimit.integration.test.ts
// (Slice 3a, 0045_workflow_plan_enforcement.sql) needs real Postgres for the
// same reason: it proves a BEFORE INSERT trigger's concurrency behavior
// under pg_advisory_xact_lock, which no mock can meaningfully stand in for.
// Kept out of the default `pnpm test` (vitest.config.ts) run so a failing
// unit suite always means a real regression, not "Redis/Postgres wasn't
// up." Run explicitly with `pnpm test:integration`.
export default defineConfig({
  test: {
    include: [
      "src/lib/sse.replay.test.ts",
      "src/lib/checksQueue.timeout.test.ts",
      "src/scripts/manageStaff.atomicity.integration.test.ts",
      "src/scripts/manageStaff.resetTwoFactor.integration.test.ts",
      "src/lib/staffAudit.integration.test.ts",
      "src/lib/orgPlan.integration.test.ts",
      "src/lib/workflowLimit.integration.test.ts",
      "src/lib/projectLimit.integration.test.ts",
      "src/services/dashboard.integration.test.ts",
      "src/lib/invites.integration.test.ts",
    ],
    env: {
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_ANON_KEY: "test-anon-key",
      WEB_ORIGIN: "http://localhost:3100",
      NIA_SECRET_MASTER_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    },
    testTimeout: 15_000,
  },
});
