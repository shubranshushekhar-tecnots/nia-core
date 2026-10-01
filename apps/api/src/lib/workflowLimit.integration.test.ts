import { afterAll, describe, expect, it } from "vitest";
import { dbPool } from "./dbPool.js";

/**
 * Console v1 Slice 3a (docs/plans/console-plan.md, build order step 8):
 * proves 0045_workflow_plan_enforcement.sql's `private.enforce_workflow_limit()`
 * BEFORE INSERT trigger — the ultimate source of truth for workflow_limit,
 * independent of apps/web's application-level pre-check
 * (dashboard/actions.ts's checkWorkflowLimit, which has its own race window
 * between the check and the insert — see client.ts's header comment on why
 * withActingUser/withServiceRole never bundle independent calls into one
 * transaction).
 *
 * Runs directly against the pool's raw DATABASE_URL owner connection (same
 * pattern as orgPlan.integration.test.ts / dashboard.integration.test.ts) —
 * the trigger fires on ANY insert into public.workflows regardless of role,
 * so no withServiceRole/withActingUser wrapper is needed to prove it.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

type PgError = Error & { code?: string };

afterAll(async () => {
  await dbPool.end();
});

async function makeOrgWithLimit(limit: number | null): Promise<{ orgId: string; projectId: string; userId: string }> {
  const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
  const userId = userRows[0]?.id;
  if (!userId) throw new Error("no fixture user found — run `pnpm --filter @nia/api seed:fixtures` first");

  const { rows: orgRows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    [
      "workflow limit trigger test org",
      // slug must match organizations_slug_check (0001_auth_orgs.sql):
      // ^[a-z0-9]+(-[a-z0-9]+)*$ — lowercase/digits/single-hyphens only, no
      // periods, so Math.random()'s decimal string can't be used directly.
      `workflow-limit-trigger-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
    ],
  );
  const orgId = orgRows[0]!.id;

  // 0043's trigger already created a Free/plan-default org_plan row for
  // this org (no override) — set an explicit override to the boundary
  // this test needs. plan_id stays 'free', so the trigger's message names
  // the Free plan.
  await dbPool.query("update public.org_plan set workflow_limit_set = true, workflow_limit = $1 where org_id = $2", [
    limit,
    orgId,
  ]);

  const { rows: projectRows } = await dbPool.query<{ id: string }>(
    `insert into public.projects (org_id, name, created_by) values ($1, $2, $3) returning id`,
    [orgId, "workflow limit trigger test project", userId],
  );
  const projectId = projectRows[0]!.id;

  return { orgId, projectId, userId };
}

async function dropOrg(orgId: string): Promise<void> {
  // workflows/projects/org_plan all reference organizations(id) on delete
  // cascade.
  await dbPool.query("delete from public.organizations where id = $1", [orgId]);
}

async function insertWorkflow(projectId: string, orgId: string, userId: string, name: string) {
  return dbPool.query<{ id: string }>(
    `insert into public.workflows (project_id, org_id, name, created_by) values ($1, $2, $3, $4) returning id`,
    [projectId, orgId, name, userId],
  );
}

describe("private.enforce_workflow_limit() — org-scoped, real Postgres", () => {
  it("allows the Nth workflow (at the limit) and refuses the N+1th with the exact customer-visible message and errcode NIA01", async () => {
    const { orgId, projectId, userId } = await makeOrgWithLimit(2);

    try {
      await insertWorkflow(projectId, orgId, userId, "wf-1");
      await insertWorkflow(projectId, orgId, userId, "wf-2");

      await expect(insertWorkflow(projectId, orgId, userId, "wf-3")).rejects.toMatchObject({
        code: "NIA01",
        message: "Your Free plan allows 2 workflows. Delete one or upgrade to add more.",
      } satisfies Partial<PgError>);

      const { rows } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.workflows where org_id = $1",
        [orgId],
      );
      // The refused 3rd insert must not have left a row behind.
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("null workflow_limit means unlimited — inserts past the old default keep succeeding", async () => {
    const { orgId, projectId, userId } = await makeOrgWithLimit(null);

    try {
      for (let i = 0; i < 3; i++) {
        await expect(insertWorkflow(projectId, orgId, userId, `wf-unlimited-${i}`)).resolves.toBeTruthy();
      }
    } finally {
      await dropOrg(orgId);
    }
  });

  it("lowering the limit below the org's current workflow count leaves existing workflows untouched but refuses new ones", async () => {
    // Console-plan.md sub-slice: staff can PATCH workflow_limit below an
    // org's current usage (e.g. 18 workflows -> limit 10). The trigger only
    // fires on INSERT, never UPDATE/DELETE, so this must never touch
    // existing rows — it just closes the door on new ones.
    const { orgId, projectId, userId } = await makeOrgWithLimit(5);

    try {
      for (let i = 0; i < 5; i++) {
        await insertWorkflow(projectId, orgId, userId, `wf-preexisting-${i}`);
      }

      // Staff lowers the limit below current usage (5 -> 2).
      await dbPool.query("update public.org_plan set workflow_limit_set = true, workflow_limit = $1 where org_id = $2", [
        2,
        orgId,
      ]);

      // Existing 5 rows are untouched by the plan change alone.
      const { rows: afterLower } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.workflows where org_id = $1",
        [orgId],
      );
      expect(Number(afterLower[0]?.count)).toBe(5);

      // A new insert is refused, citing the NEW (lower) limit.
      await expect(insertWorkflow(projectId, orgId, userId, "wf-after-lower")).rejects.toMatchObject({
        code: "NIA01",
        message: "Your Free plan allows 2 workflows. Delete one or upgrade to add more.",
      } satisfies Partial<PgError>);

      // Still 5 — the refused insert left no row behind, and the 5
      // pre-existing rows are still exactly as they were.
      const { rows: afterRefusal } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.workflows where org_id = $1",
        [orgId],
      );
      expect(Number(afterRefusal[0]?.count)).toBe(5);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("is concurrency-safe: two simultaneous inserts at the boundary never both succeed past the limit", async () => {
    const { orgId, projectId, userId } = await makeOrgWithLimit(1);

    try {
      const results = await Promise.allSettled([
        insertWorkflow(projectId, orgId, userId, "wf-race-a"),
        insertWorkflow(projectId, orgId, userId, "wf-race-b"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as PgError).code).toBe("NIA01");
      expect((rejected[0]!.reason as PgError).message).toBe(
        "Your Free plan allows 1 workflow. Delete one or upgrade to add more.",
      );

      const { rows } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.workflows where org_id = $1",
        [orgId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await dropOrg(orgId);
    }
  });
});

async function makePersonalTestUser(): Promise<{ userId: string }> {
  // A dedicated, freshly created user — never the shared fixture user —
  // so this test's project insert can never collide with pre-existing
  // personal projects/workflows left over from other runs or seed data
  // (that's what made this test flaky: the shared fixture user's project
  // count could already be at/over the Free plan's project_limit=1,
  // tripping private.enforce_project_limit() before this test even got to
  // the workflow-limit trigger it's actually testing). A brand-new user
  // starts at zero projects/workflows, so 0051's set_default_owner_plan
  // trigger's Free-plan defaults (project_limit=1, workflow_limit=2) are
  // always satisfiable here regardless of what any other data looks like.
  const email = `workflow-limit-trigger-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@nia-test.invalid`;
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public."user" (name, email) values ($1, $2) returning id`,
    ["workflow limit trigger test user", email],
  );
  return { userId: rows[0]!.id };
}

async function dropPersonalTestUser(userId: string, projectId: string | undefined): Promise<void> {
  // workflows.project_id -> projects(id) is ON DELETE CASCADE (0002), so
  // deleting the project also removes any workflows created under it.
  // projects/workflows.created_by/owner_id -> public.user(id) has no
  // cascade (0035 preserves each column's original, un-cascaded FK
  // behavior), so the project must be gone before the user can be deleted.
  if (projectId) await dbPool.query("delete from public.projects where id = $1", [projectId]);
  await dbPool.query('delete from public."user" where id = $1', [userId]);
}

describe("private.enforce_workflow_limit() — personal (owner_id) workspace, real Postgres", () => {
  it("resolves a fresh user's real owner_plan (plan name + effective limit) and names that plan in the refusal", async () => {
    const { userId } = await makePersonalTestUser();
    let projectId: string | undefined;

    try {
      // Don't hardcode which plan a new user lands on — read the actual
      // effective limit/name owner_plan+plans resolve to, the same way
      // the trigger itself does (0051 defaults new users to 'free', but
      // this keeps the assertion honest against the real resolved data
      // rather than assuming that default never changes).
      const { rows: planRows } = await dbPool.query<{ plan_name: string; effective_limit: number | null }>(
        `select pl.name as plan_name,
                case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as effective_limit
           from public.owner_plan op
           join public.plans pl on pl.id = op.plan_id
          where op.user_id = $1`,
        [userId],
      );
      const { plan_name: planName, effective_limit: limit } = planRows[0]!;
      expect(limit).not.toBeNull();

      const { rows: projectRows } = await dbPool.query<{ id: string }>(
        `insert into public.projects (owner_id, name, created_by) values ($1, $2, $1) returning id`,
        [userId, "workflow limit trigger test personal project"],
      );
      projectId = projectRows[0]!.id;

      const insertPersonalWorkflow = (name: string) =>
        dbPool.query<{ id: string }>(
          `insert into public.workflows (project_id, owner_id, name, created_by) values ($1, $2, $3, $2) returning id`,
          [projectId, userId, name],
        );

      // A fresh user has zero personal workflows, so the boundary is
      // exactly `limit` inserts — no need to read/top-up an existing count.
      for (let i = 0; i < limit!; i++) {
        await insertPersonalWorkflow(`wf-personal-${i}`);
      }

      await expect(insertPersonalWorkflow("wf-personal-over-limit")).rejects.toMatchObject({
        code: "NIA01",
        message: `Your ${planName} plan allows ${limit} workflow${limit === 1 ? "" : "s"}. Delete one or upgrade to add more.`,
      } satisfies Partial<PgError>);
    } finally {
      await dropPersonalTestUser(userId, projectId);
    }
  });
});
