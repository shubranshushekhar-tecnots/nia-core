import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import type { Queryable } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { getDashboardStats } from "./dashboard.js";

/**
 * Console v1 follow-up ("Slice 2 nearly approved" review, req. 2; "Slice 2
 * follow-ups" review, req. 2 revisit). Proves getDashboardStats() actually
 * reads org_plan (via getOrgPlan's own withUser query, RLS-scoped by
 * 0044_org_plan_member_select.sql's member-only SELECT policy) rather than
 * returning a hardcoded constant, so a Console plan change reaches the
 * customer-facing render (apps/web/src/lib/billing/plan.ts's
 * getPlanUsage()) instead of being silently ignored.
 *
 * Subscription model Phase 1: updated for org_plan's plan_id/override-flag
 * columns (0049/0050) — a freshly created org now defaults to plan_id
 * 'free' (workflow_limit 2, project_limit 1) via 0043's create trigger,
 * not the old hardcoded Pro/25. projectLimit is asserted alongside
 * workflowLimit since both now resolve through the same plan row.
 *
 * getOrgPlan no longer goes through withServiceRole, and it no longer
 * short-circuits for personal scopes either — both the org and the
 * personal-workspace test below need a real RLS-scoped connection
 * (withActingUser), as an actual org member / the owning user respectively,
 * or the scoped policies would correctly return zero rows and the tests
 * would only ever see the fallback. A stub that ignores query text can't
 * stand in for this. project/workflow counts come along for the ride via
 * the same real connection — they're 0 for the org case because no
 * projects/workflows exist for that fixture org, not because of a stub.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

describe("getDashboardStats — org_plan read path, real Postgres", () => {
  it("an org with the 0043 default row reports Free plan/workflow_limit 2/project_limit 1; overrides change what the customer sees", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>(
      'select id from public."user" limit 1',
    );
    const createdBy = userRows[0]?.id;
    expect(createdBy).toBeTruthy();

    const { rows: orgRows } = await dbPool.query<{ id: string }>(
      `insert into public.organizations (name, slug, created_by)
       values ($1, $2, $3)
       returning id`,
      [
        "dashboard org_plan read test org",
        `dashboard-org-plan-read-test-${Date.now()}`,
        createdBy,
      ],
    );
    const orgId = orgRows[0]?.id;
    expect(orgId).toBeTruthy();

    // The raw insert above (unlike public.create_organization()) does not
    // create an organization_members row, so createdBy would fail
    // 0044_org_plan_member_select.sql's private.is_member(org_id) check —
    // add one directly (role 'member', not 'owner', so cleanup below never
    // trips private.protect_last_super_admin's last-owner guard).
    await dbPool.query(
      "insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'member')",
      [orgId, createdBy],
    );

    const memberWithUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> =>
      withActingUser(dbPool, createdBy!, fn);

    try {
      // 1. Default row (from 0043's trigger, fired by the insert above) —
      // no override, so the effective limits are Free's own plan
      // defaults.
      const defaultStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(defaultStats.planTier).toBe("Free");
      expect(defaultStats.workflowLimit).toBe(2);
      expect(defaultStats.projectLimit).toBe(1);
      // Subscription Phase 3, Slice 4 — Free's plan-catalog defaults
      // (0049_plans_table.sql), no usage recorded yet for this fresh org.
      expect(defaultStats.rowsLimit).toBe(100000);
      expect(defaultStats.copilotLimit).toBe(50);
      expect(defaultStats.rowsUsed).toBe(0);
      expect(defaultStats.copilotUsed).toBe(0);

      // Record one of each usage kind directly against the ledger (Slices
      // 2/3 own the insert paths themselves) and confirm getDashboardStats
      // sums them back out, scoped to this org and the current month.
      await dbPool.query(
        `insert into public.usage_events (org_id, kind, quantity, subject_id) values ($1, 'rows_moved', 1234, $2)`,
        [orgId, randomUUID()],
      );
      await dbPool.query(
        `insert into public.usage_events (org_id, kind, quantity, subject_id) values ($1, 'copilot_action', 1, $2)`,
        [orgId, randomUUID()],
      );

      const withUsageStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(withUsageStats.rowsUsed).toBe(1234);
      expect(withUsageStats.copilotUsed).toBe(1);

      // 2. Simulate a Console plan change: switch to Team with an explicit
      // workflow_limit override, no project_limit override.
      await dbPool.query(
        `update public.org_plan
         set plan_id = 'team', workflow_limit_set = true, workflow_limit = $1
         where org_id = $2`,
        [10, orgId],
      );

      const changedStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(changedStats.planTier).toBe("Team");
      expect(changedStats.workflowLimit).toBe(10);

      // 3. workflow_limit override = null means an explicit unlimited
      // override — must be preserved, not collapsed back to a default.
      await dbPool.query(
        "update public.org_plan set workflow_limit = null where org_id = $1",
        [orgId],
      );

      const unlimitedStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(unlimitedStats.workflowLimit).toBeNull();
    } finally {
      // org_plan.org_id references organizations(id) on delete cascade.
      await dbPool.query("delete from public.organizations where id = $1", [
        orgId,
      ]);
    }
  });

  it("a personal workspace resolves the fixture user's real owner_plan row (no hardcoded fallback)", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>(
      'select id from public."user" limit 1',
    );
    const ownerId = userRows[0]?.id;
    expect(ownerId).toBeTruthy();

    const { rows: planRows } = await dbPool.query<{ plan_name: string; workflow_limit: number | null }>(
      `select pl.name as plan_name,
              case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as workflow_limit
         from public.owner_plan op
         join public.plans pl on pl.id = op.plan_id
        where op.user_id = $1`,
      [ownerId],
    );
    const { plan_name: expectedPlan, workflow_limit: expectedLimit } = planRows[0]!;

    // getOrgPlan no longer short-circuits for personal scopes — it queries
    // owner_plan directly, RLS-scoped by the owner-only policy — so this
    // needs a real acting-user connection, not a stub, to prove the read
    // actually goes through the real row rather than any hardcoded value.
    const ownerWithUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> => withActingUser(dbPool, ownerId!, fn);

    const stats = await getDashboardStats(ownerWithUser, { ownerId: ownerId! });
    expect(stats.planTier).toBe(expectedPlan);
    expect(stats.workflowLimit).toBe(expectedLimit);
  });
});
