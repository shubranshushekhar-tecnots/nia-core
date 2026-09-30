import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import { auth } from "./auth.js";
import { dbPool } from "./dbPool.js";

/**
 * Console v1, build order Step 7 (docs/plans/console-plan.md §2, §5,
 * decision 6) — extended for subscription-model Phase 1 (0049-0051).
 *
 * Proves the plans/org_plan/owner_plan migrations changed NOTHING
 * observable about an existing org's or user's effective limit on the day
 * they ran: 0050/0051's backfill sets `plan_id='legacy'` with NO override
 * (`workflow_limit_set=false`, `project_limit_set=false`) rather than
 * carrying forward the raw Pro/25 values directly, so what's actually
 * being proven is that resolving the limit through
 * `case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end`
 * (the same expression private.enforce_workflow_limit() and
 * getOrgPlan()/resolvePlanLimit() use) reproduces the exact prior
 * constant (25 workflows, unlimited projects) for every backfilled row —
 * a later plan change (Legacy -> Pro) would otherwise silently stay capped
 * at the old default forever. The "backfill" describe blocks below don't
 * depend on a real 0050/0051 backfill having produced rows (a from-zero
 * database has none — those migrations' UPDATEs ran against empty tables):
 * they build a row in the backfill's exact documented shape and assert the
 * same resolution expression, so they pass identically on a from-zero
 * database or one with real production history.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

describe("org_plan backfill — real Postgres", () => {
  it("an org_plan row left in the 0050 backfill's exact shape (plan_id='legacy', no override) resolves to the exact prior constant (workflow_limit=25, project_limit=unlimited)", async () => {
    // Self-contained: a from-zero database has no rows left over from a
    // real 0050 backfill (that migration's UPDATE ran against an empty
    // org_plan table). Instead of depending on incidental leftover data,
    // create a real org (the auto-provisioning trigger gives it a Free
    // row), then overwrite it into 0050's documented backfill shape —
    // plan_id='legacy', workflow_limit_set=false, project_limit_set=false
    // — and assert the same resolution expression the product code and
    // the RLS trigger both use.
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
        "org_plan backfill-shape test org",
        `org-plan-backfill-test-${Date.now()}`,
        createdBy,
      ],
    );
    const orgId = orgRows[0]?.id;
    expect(orgId).toBeTruthy();

    try {
      await dbPool.query(
        `update public.org_plan
         set plan_id = 'legacy', workflow_limit_set = false, project_limit_set = false
         where org_id = $1`,
        [orgId],
      );

      const { rows } = await dbPool.query<{
        plan_id: string;
        workflow_limit_set: boolean;
        project_limit_set: boolean;
        effective_workflow_limit: number | null;
        effective_project_limit: number | null;
      }>(
        `select
           op.plan_id,
           op.workflow_limit_set,
           op.project_limit_set,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as effective_workflow_limit,
           case when op.project_limit_set then op.project_limit else pl.project_limit end as effective_project_limit
         from public.org_plan op
         join public.plans pl on pl.id = op.plan_id
         where op.org_id = $1`,
        [orgId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.plan_id).toBe("legacy");
      expect(rows[0]?.workflow_limit_set).toBe(false);
      expect(rows[0]?.project_limit_set).toBe(false);
      expect(rows[0]?.effective_workflow_limit).toBe(25);
      expect(rows[0]?.effective_project_limit).toBeNull();
    } finally {
      await dbPool.query("delete from public.organizations where id = $1", [orgId]);
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

  it("a synthetic pre-migration null-limit org_plan row maps to an explicit unlimited override, not a silently-inherited plan default", async () => {
    // Guards against the specific regression 0050's own header comment
    // calls out: a hypothetical org_plan row that had workflow_limit=null
    // BEFORE this migration (meaning "unlimited") must still mean
    // unlimited after — via workflow_limit_set=true, workflow_limit=null
    // (an explicit override), not workflow_limit_set=false (which would
    // silently fall through to the Legacy plan's own 25 default instead).
    const effective = (workflowLimitSet: boolean, workflowLimit: number | null) =>
      dbPool.query<{ effective_workflow_limit: number | null }>(
        `select case when $1 then $2::int else pl.workflow_limit end as effective_workflow_limit
         from public.plans pl where pl.id = 'legacy'`,
        [workflowLimitSet, workflowLimit],
      );

    const { rows: overrideRows } = await effective(true, null);
    expect(overrideRows[0]?.effective_workflow_limit).toBeNull();

    const { rows: noOverrideRows } = await effective(false, null);
    expect(noOverrideRows[0]?.effective_workflow_limit).toBe(25);
  });
});

/**
 * Console v1 follow-up (docs/plans/console-plan.md, "Slice 2 nearly
 * approved" review) — extended for subscription-model Phase 1: 0050
 * redefined `private.set_default_org_plan()` to default new orgs to
 * `plan_id='free'` instead of the old hardcoded Pro/25 literal.
 */
describe("org_plan auto-provisioning on org creation — real Postgres", () => {
  it("a newly inserted organization gets a Free org_plan row automatically, with no application code involved", async () => {
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
        plan_id: string;
        workflow_limit_set: boolean;
        project_limit_set: boolean;
      }>(
        "select plan_id, workflow_limit_set, project_limit_set from public.org_plan where org_id = $1",
        [orgId],
      );

      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.plan_id).toBe("free");
      expect(planRows[0]?.workflow_limit_set).toBe(false);
      expect(planRows[0]?.project_limit_set).toBe(false);
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
 * above proves 0043/0050's trigger fires on ANY insert into organizations
 * (deliberately, via a raw insert as the pool's owner role, matching
 * supabase/seed.sql's own bypass-the-RPC path — see that test's header
 * comment). This test proves the SAME trigger also fires on the actual
 * customer-facing path: public.create_organization(), called through
 * withActingUser exactly the way apps/web/src/lib/auth/actions.ts's server
 * action calls it (RLS-scoped `authenticated` role + request.jwt.claims,
 * never the raw owner connection) — so both the org row AND its Free
 * org_plan row exist after a real signup-style call.
 */
describe("org creation via the real customer path (create_organization RPC, authenticated actor) — real Postgres", () => {
  it("create_organization() as an authenticated user creates both the organization and its Free org_plan row", async () => {
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

      const { rows: planRows } = await dbPool.query<{ plan_id: string }>(
        "select plan_id from public.org_plan where org_id = $1",
        [orgId],
      );
      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.plan_id).toBe("free");
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

/**
 * Subscription model Phase 1 (0051_owner_plan_table.sql). Proves the
 * backfill's "effective limits identical before/after" claim for personal
 * (owner_id-scoped) workspaces too: every existing user's owner_plan row
 * is plan_id='legacy' with no override, resolving to the exact prior
 * hardcoded personal-workspace constant (25 workflows, unlimited projects
 * — the old enforce_workflow_limit()'s "v_limit := 25" personal branch,
 * and the fact project_limit didn't exist as an enforced concept before
 * this round at all).
 */
describe("owner_plan backfill — real Postgres", () => {
  it("an owner_plan row left in 0051's exact backfill shape (plan_id='legacy', no override) resolves to the exact prior constant", async () => {
    // Self-contained for the same reason as the org_plan backfill test
    // above: a from-zero database never ran 0051's backfill UPDATE against
    // real pre-existing rows. Sign up a real user (the auto-provisioning
    // trigger gives it a Free row), overwrite it into 0051's documented
    // backfill shape, and assert the resolution expression.
    const email = `owner-plan-backfill-shape-test-${Date.now()}@nia.dev`;
    const result = await auth.api.signUpEmail({
      body: { email, password: "password", name: "owner_plan backfill-shape test" },
    });
    const userId = result.user.id;
    expect(userId).toBeTruthy();

    try {
      await dbPool.query(
        `update public.owner_plan
         set plan_id = 'legacy', workflow_limit_set = false, project_limit_set = false
         where user_id = $1`,
        [userId],
      );

      const { rows } = await dbPool.query<{
        plan_id: string;
        workflow_limit_set: boolean;
        project_limit_set: boolean;
        effective_workflow_limit: number | null;
        effective_project_limit: number | null;
      }>(
        `select
           op.plan_id,
           op.workflow_limit_set,
           op.project_limit_set,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as effective_workflow_limit,
           case when op.project_limit_set then op.project_limit else pl.project_limit end as effective_project_limit
         from public.owner_plan op
         join public.plans pl on pl.id = op.plan_id
         where op.user_id = $1`,
        [userId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.plan_id).toBe("legacy");
      expect(rows[0]?.workflow_limit_set).toBe(false);
      expect(rows[0]?.project_limit_set).toBe(false);
      expect(rows[0]?.effective_workflow_limit).toBe(25);
      expect(rows[0]?.effective_project_limit).toBeNull();
    } finally {
      await dbPool.query('delete from public."user" where id = $1', [userId]);
    }
  });

  it("every user has a corresponding owner_plan row (backfill covered every pre-existing user, none skipped)", async () => {
    const { rows } = await dbPool.query<{ missing_count: string }>(
      `select count(*) as missing_count
       from public."user" u
       left join public.owner_plan op on op.user_id = u.id
       where op.user_id is null`,
    );

    expect(Number(rows[0]?.missing_count ?? -1)).toBe(0);
  });
});

/**
 * Subscription model Phase 1 (0051_owner_plan_table.sql). Proves
 * `private.set_default_owner_plan()`'s AFTER INSERT trigger on
 * public."user" fires on the real signup path — Better Auth's
 * signUpEmail() (apps/api/src/scripts/seedFixtureUsers.ts's own precedent
 * for exercising this exact path in a test rather than a raw insert into
 * public."user", since the password hash format is internal to Better
 * Auth) — not just on a direct insert.
 */
describe("owner_plan auto-provisioning on signup — real Postgres", () => {
  it("signing up through the real signUpEmail path creates both the user row and a Free owner_plan row", async () => {
    const email = `owner-plan-signup-test-${Date.now()}@nia.dev`;
    const result = await auth.api.signUpEmail({ body: { email, password: "password", name: "owner_plan signup test" } });
    const userId = result.user.id;
    expect(userId).toBeTruthy();

    try {
      const { rows: planRows } = await dbPool.query<{
        plan_id: string;
        workflow_limit_set: boolean;
        project_limit_set: boolean;
      }>(
        "select plan_id, workflow_limit_set, project_limit_set from public.owner_plan where user_id = $1",
        [userId],
      );

      expect(planRows).toHaveLength(1);
      expect(planRows[0]?.plan_id).toBe("free");
      expect(planRows[0]?.workflow_limit_set).toBe(false);
      expect(planRows[0]?.project_limit_set).toBe(false);
    } finally {
      // owner_plan.user_id references "user"(id) on delete cascade.
      await dbPool.query('delete from public."user" where id = $1', [userId]);
    }
  });
});
