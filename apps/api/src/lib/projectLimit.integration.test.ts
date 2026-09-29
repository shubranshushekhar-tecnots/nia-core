import { afterAll, describe, expect, it } from "vitest";
import { dbPool } from "./dbPool.js";

/**
 * Subscription model Phase 1, build order step 4: proves
 * 0052_project_limit_enforcement.sql's `private.enforce_project_limit()`
 * BEFORE INSERT trigger — mirrors workflowLimit.integration.test.ts's
 * org-scoped coverage exactly (same advisory-lock/plan-resolution shape,
 * same trigger pattern already proven there for concurrency +
 * lower-limit-doesn't-touch-existing-rows), so this file stays lean and
 * only proves what's actually new here: the NIA02 errcode and the
 * project-specific message wording ("Upgrade to add more.", no "Delete
 * one" — you can't delete a project to free up room for a new project the
 * same way you delete a workflow).
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

type PgError = Error & { code?: string };

afterAll(async () => {
  await dbPool.end();
});

async function makeOrgWithProjectLimit(limit: number | null): Promise<{ orgId: string; userId: string }> {
  const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
  const userId = userRows[0]?.id;
  if (!userId) throw new Error("no fixture user found — run `pnpm --filter @nia/api seed:fixtures` first");

  const { rows: orgRows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    [
      "project limit trigger test org",
      `project-limit-trigger-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
    ],
  );
  const orgId = orgRows[0]!.id;

  // 0043's trigger already created a Free/plan-default org_plan row —
  // set an explicit override to the boundary this test needs. plan_id
  // stays 'free', so the trigger's message names the Free plan.
  await dbPool.query("update public.org_plan set project_limit_set = true, project_limit = $1 where org_id = $2", [
    limit,
    orgId,
  ]);

  return { orgId, userId };
}

async function dropOrg(orgId: string): Promise<void> {
  await dbPool.query("delete from public.organizations where id = $1", [orgId]);
}

async function insertProject(orgId: string, userId: string, name: string) {
  return dbPool.query<{ id: string }>(
    `insert into public.projects (org_id, name, created_by) values ($1, $2, $3) returning id`,
    [orgId, name, userId],
  );
}

describe("private.enforce_project_limit() — org-scoped, real Postgres", () => {
  it("allows the Nth project (at the limit) and refuses the N+1th with errcode NIA02 and the plan-named message", async () => {
    const { orgId, userId } = await makeOrgWithProjectLimit(1);

    try {
      await insertProject(orgId, userId, "proj-1");

      await expect(insertProject(orgId, userId, "proj-2")).rejects.toMatchObject({
        code: "NIA02",
        message: "Your Free plan allows 1 project. Upgrade to add more.",
      } satisfies Partial<PgError>);

      const { rows } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.projects where org_id = $1",
        [orgId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("null project_limit means unlimited", async () => {
    const { orgId, userId } = await makeOrgWithProjectLimit(null);

    try {
      for (let i = 0; i < 3; i++) {
        await expect(insertProject(orgId, userId, `proj-unlimited-${i}`)).resolves.toBeTruthy();
      }
    } finally {
      await dropOrg(orgId);
    }
  });
});
