import { afterAll, describe, expect, it } from "vitest";
import type { Queryable } from "@nia/db";
import { withActingUser } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { getDashboardStats } from "./dashboard.js";

/**
 * Console v1 follow-up ("Slice 2 nearly approved" review, req. 2; "Slice 2
 * follow-ups" review, req. 2 revisit). Proves getDashboardStats() actually
 * reads org_plan (via getOrgPlan's own withUser query, RLS-scoped by
 * 0044_org_plan_member_select.sql's member-only SELECT policy) rather than
 * returning a hardcoded constant, so a Slice 3a plan change reaches the
 * customer-facing render (apps/web/src/lib/billing/plan.ts's
 * getPlanUsage()) instead of being silently ignored.
 *
 * getOrgPlan no longer goes through withServiceRole, so this test can't use
 * a stub that ignores query text/real DB state for the org test below
 * (stubWithUser was only ever a valid stand-in while org_plan reads bypassed
 * RLS entirely) — it must run through a real RLS-scoped connection
 * (withActingUser) as an actual member of the org, or the member-scoped
 * policy would correctly return zero rows and the test would only ever see
 * the Pro/25 fallback, masking a real regression. project/workflow counts
 * come along for the ride via the same real connection — they're 0 because
 * no projects/workflows exist for this fixture org, not because of a stub.
 *
 * The personal-workspace test below still uses a stub: getOrgPlan()
 * short-circuits before any query for personal scopes, so the project/
 * workflow count queries genuinely don't need real Postgres state there.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

const stubWithUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> =>
  fn({
    query: async <R extends Record<string, unknown> = Record<string, unknown>>() => ({
      rows: [{ count: 0 }] as unknown as R[],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }),
  });

afterAll(async () => {
  await dbPool.end();
});

describe("getDashboardStats — org_plan read path, real Postgres", () => {
  it("an org with the 0042/0043 default row reports workflow_limit 25, plan_tier Pro; a changed row changes what the customer sees", async () => {
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
      // the customer-visible limit must still be exactly what
      // getPlanUsage() has always hardcoded.
      const defaultStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(defaultStats.planTier).toBe("Pro");
      expect(defaultStats.workflowLimit).toBe(25);

      // 2. Simulate a Slice 3a plan change directly against org_plan.
      await dbPool.query(
        "update public.org_plan set plan_tier = $1, workflow_limit = $2 where org_id = $3",
        ["Team", 10, orgId],
      );

      const changedStats = await getDashboardStats(memberWithUser, { orgId: orgId! });
      expect(changedStats.planTier).toBe("Team");
      expect(changedStats.workflowLimit).toBe(10);

      // 3. workflow_limit = null means unlimited — must be preserved, not
      // collapsed back to a default.
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

  it("a personal workspace (no org at all) defaults to Pro/25 without querying org_plan", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>(
      'select id from public."user" limit 1',
    );
    const ownerId = userRows[0]?.id;
    expect(ownerId).toBeTruthy();

    const stats = await getDashboardStats(stubWithUser, { ownerId: ownerId! });
    expect(stats.planTier).toBe("Pro");
    expect(stats.workflowLimit).toBe(25);
  });
});
