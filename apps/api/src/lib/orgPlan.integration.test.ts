import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import { dbPool } from "./dbPool.js";

/**
 * Console v1, build order Step 7 (docs/plans/console-plan.md §2, §5,
 * decision 6). Proves 0042_org_plan.sql's backfill reproduces
 * apps/web/src/lib/billing/plan.ts's getPlanUsage() constant EXACTLY for
 * every org that existed when the migration ran — i.e. that introducing
 * the new explicit org_plan table changes nothing observable about an
 * existing org's plan/limit on the day it's introduced.
 *
 * getPlanUsage() today: `{ plan: 'Pro', limit: 25, used: workflowCount }`.
 * `used` is computed on read (not stored), so it's out of scope for this
 * backfill-exactness test — GET /console/orgs/:orgId's own unit tests
 * (routes/console.test.ts) already cover the on-read usage computation.
 * What this test proves is narrower and specific to the migration itself:
 * every row org_plan's backfill INSERT produced has plan_tier='Pro' and
 * workflow_limit=25, with no exceptions.
 *
 * Queries org_plan directly via the pooled DATABASE_URL owner connection
 * (not withServiceRole) — reading, not exercising the service-role grant
 * path, which Probe 54 (supabase/tests/rls_probes.sql) and
 * staffAudit.integration.test.ts already cover from different angles.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

describe("org_plan backfill — real Postgres", () => {
  it("every existing org_plan row (the 0042 backfill) matches getPlanUsage()'s exact prior constant: plan_tier='Pro', workflow_limit=25", async () => {
    const { rows, rowCount } = await dbPool.query<{
      org_id: string;
      plan_tier: string;
      workflow_limit: number | null;
    }>("select org_id, plan_tier, workflow_limit from public.org_plan");

    expect(rowCount).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.plan_tier).toBe("Pro");
      expect(row.workflow_limit).toBe(25);
    }
  });

  it("every organization has a corresponding org_plan row (backfill covered every pre-existing org, none skipped)", async () => {
    const { rows } = await dbPool.query<{ missing_count: string }>(
      `select count(*) as missing_count
       from public.organizations o
       left join public.org_plan op on op.org_id = o.id
       where op.org_id is null`,
    );

    expect(Number(rows[0]?.missing_count ?? -1)).toBe(0);
  });
});

/**
 * Console v1 follow-up (docs/plans/console-plan.md, "Slice 2 nearly
 * approved" review). 0042's backfill only covered orgs that existed when
 * that migration ran — this proves 0043_org_plan_default_on_create.sql's
 * `organizations_set_default_org_plan` AFTER INSERT trigger covers every
 * org created AFTER, regardless of insert path (this test inserts into
 * public.organizations directly, the same way supabase/seed.sql does,
 * bypassing the create_organization() RPC entirely — proving the trigger,
 * not the RPC body, is what guarantees the row).
 */
describe("org_plan auto-provisioning on org creation — real Postgres", () => {
  it("a newly inserted organization gets a Pro/25 org_plan row automatically, with no application code involved", async () => {
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
        "org_plan trigger test org",
        `org-plan-trigger-test-${Date.now()}`,
        createdBy,
      ],
    );
    const orgId = orgRows[0]?.id;
    expect(orgId).toBeTruthy();

    try {
      const { rows: planRows } = await dbPool.query<{
        plan_tier: string;
        workflow_limit: number | null;
      }>(
        "select plan_tier, workflow_limit from public.org_plan where org_id = $1",
        [orgId],
      );

      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.plan_tier).toBe("Pro");
      expect(planRows[0]?.workflow_limit).toBe(25);
    } finally {
      // org_plan.org_id references organizations(id) on delete cascade —
      // deleting the org cleans up the org_plan row too.
      await dbPool.query("delete from public.organizations where id = $1", [
        orgId,
      ]);
    }
  });
});

/**
 * Console v1 follow-up ("Slice 2 follow-ups" review). The trigger test
 * above proves 0043 fires on ANY insert into organizations (deliberately,
 * via a raw insert as the pool's owner role, matching supabase/seed.sql's
 * own bypass-the-RPC path — see that test's header comment). This test
 * proves the SAME trigger also fires on the actual customer-facing path:
 * public.create_organization(), called through withActingUser exactly the
 * way apps/web/src/lib/auth/actions.ts's server action calls it (RLS-scoped
 * `authenticated` role + request.jwt.claims, never the raw owner
 * connection) — so both the org row AND its org_plan row exist after a
 * real signup-style call, not just after a privileged direct insert.
 */
describe("org creation via the real customer path (create_organization RPC, authenticated actor) — real Postgres", () => {
  it("create_organization() as an authenticated user creates both the organization and its org_plan row", async () => {
    const { rows: userRows } = await dbPool.query<{ id: string }>(
      'select id from public."user" limit 1',
    );
    const userId = userRows[0]?.id;
    expect(userId).toBeTruthy();

    const slug = `org-plan-rpc-test-${Date.now()}`;
    const { rows: rpcRows } = await withActingUser(dbPool, userId!, (db) =>
      db.query<{ create_organization: string }>(
        "select public.create_organization($1, $2) as create_organization",
        ["org_plan RPC test org", slug],
      ),
    );
    const orgId = rpcRows[0]?.create_organization;
    expect(orgId).toBeTruthy();

    try {
      const { rows: orgRows } = await dbPool.query<{ id: string; created_by: string }>(
        "select id, created_by from public.organizations where id = $1",
        [orgId],
      );
      expect(orgRows).toHaveLength(1);
      expect(orgRows[0]?.created_by).toBe(userId);

      const { rows: memberRows } = await dbPool.query<{ role: string }>(
        "select role from public.organization_members where org_id = $1 and user_id = $2",
        [orgId, userId],
      );
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]?.role).toBe("owner");

      const { rows: planRows } = await dbPool.query<{
        plan_tier: string;
        workflow_limit: number | null;
      }>(
        "select plan_tier, workflow_limit from public.org_plan where org_id = $1",
        [orgId],
      );
      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.plan_tier).toBe("Pro");
      expect(planRows[0]?.workflow_limit).toBe(25);
    } finally {
      // create_organization() (unlike the raw inserts the other tests in
      // this file use) also inserts an organization_members 'owner' row —
      // deleting the org cascades into deleting that row, which trips
      // private.protect_last_super_admin's "cannot remove the last owner"
      // guard (an unconditional BEFORE DELETE trigger, fires regardless of
      // role). Disabling it for this one cleanup statement, as the table
      // owner, then re-enabling it immediately, is the same explicit/
      // reviewable pattern 0040_staff_audit_log.sql's header comment
      // documents for this exact class of table-owner action.
      await dbPool.query(
        "alter table public.organization_members disable trigger organization_members_protect_last_super_admin",
      );
      try {
        await dbPool.query("delete from public.organizations where id = $1", [orgId]);
      } finally {
        await dbPool.query(
          "alter table public.organization_members enable trigger organization_members_protect_last_super_admin",
        );
      }
    }
  });
});
