import { afterAll, describe, expect, it } from "vitest";
import { dbPool } from "./dbPool.js";

/**
 * 0078_console_copilot_rows_overrides.sql: proves `private.effective_plan()`
 * — the single source of truth every enforcement/display call site resolves
 * through (the two DB triggers in that same migration, chat.ts's
 * assertCopilotActionAllowed, runs.ts's assertRowsLimitNotExceeded,
 * apps/worker's runEtl.ts rows-limit check, and Console's GET /orgs/:orgId
 * and GET /users/:userId) — correctly separates an org's/owner's permanent
 * BASE plan (plan_id, written only by apply_subscription_webhook/signup
 * defaults) from a staff "grant" (grant_plan_id + grant_*_set overrides +
 * grant_expires_at): an expired grant must revert the effective plan to the
 * base plan_id, never to a hardcoded 'free' (the bug this migration fixes —
 * see its own header comment).
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

async function makeTestOrg(): Promise<{ orgId: string; userId: string }> {
  const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
  const userId = userRows[0]?.id;
  if (!userId) throw new Error("no fixture user found — run `pnpm --filter @nia/api seed:fixtures` first");

  const { rows: orgRows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    [
      "effective plan test org",
      `effective-plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
    ],
  );
  return { orgId: orgRows[0]!.id, userId };
}

async function dropOrg(orgId: string): Promise<void> {
  // org_plan references organizations(id) on delete cascade.
  await dbPool.query("delete from public.organizations where id = $1", [orgId]);
}

type EffectivePlanRow = {
  plan_id: string;
  plan_name: string;
  workflow_limit: number | null;
  project_limit: number | null;
  copilot_actions_per_month: number | null;
  rows_per_month: number | null;
  rows_override_active: boolean;
  expired: boolean;
};

async function readEffectivePlan(orgId: string): Promise<EffectivePlanRow> {
  const { rows } = await dbPool.query<EffectivePlanRow>(
    `select plan_id, plan_name, workflow_limit, project_limit, copilot_actions_per_month, rows_per_month, rows_override_active, expired
       from private.effective_plan($1, null)`,
    [orgId],
  );
  return rows[0]!;
}

describe("private.effective_plan() — org-scoped, real Postgres", () => {
  it("Pro base + expired grant reverts to Pro (never Free)", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'pro',
               grant_plan_id = 'team',
               grant_copilot_actions_per_month_set = true,
               grant_copilot_actions_per_month = 9999,
               grant_expires_at = now() - interval '1 day'
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      expect(plan.plan_id).toBe("pro");
      expect(plan.plan_name).toBe("Pro");
      expect(plan.expired).toBe(true);
      // Grant's copilot override must not apply once expired — falls back
      // to Pro's own catalog value, not the grant's 9999, and definitely
      // not Free's 50.
      expect(plan.copilot_actions_per_month).toBe(500);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("a grant without an expiry stays active indefinitely", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'pro',
               grant_plan_id = 'team',
               grant_expires_at = null
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      expect(plan.plan_id).toBe("team");
      expect(plan.plan_name).toBe("Team");
      expect(plan.expired).toBe(false);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("no grant at all resolves straight to the base plan", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'pro', grant_plan_id = null, grant_expires_at = null
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      expect(plan.plan_id).toBe("pro");
      expect(plan.expired).toBe(false);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("an expired grant also clears its copilot/rows overrides, falling back to the base plan's catalog values", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'free',
               grant_plan_id = null,
               grant_rows_per_month_set = true,
               grant_rows_per_month = 999999999,
               grant_expires_at = now() - interval '1 hour'
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      expect(plan.plan_id).toBe("free");
      expect(plan.expired).toBe(true);
      expect(plan.rows_per_month).toBe(100000);
      expect(plan.rows_override_active).toBe(false);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("an active grant's rows override applies even on a non-Free base plan", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'pro',
               grant_plan_id = null,
               grant_rows_per_month_set = true,
               grant_rows_per_month = 42,
               grant_expires_at = null
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      expect(plan.plan_id).toBe("pro");
      expect(plan.rows_per_month).toBe(42);
      expect(plan.rows_override_active).toBe(true);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("workflow_limit_set/project_limit_set (permanent overrides) are unaffected by grant expiry", async () => {
    const { orgId } = await makeTestOrg();
    try {
      await dbPool.query(
        `update public.org_plan
           set plan_id = 'pro',
               workflow_limit_set = true,
               workflow_limit = 7,
               grant_plan_id = 'team',
               grant_expires_at = now() - interval '1 day'
         where org_id = $1`,
        [orgId],
      );

      const plan = await readEffectivePlan(orgId);
      // Grant expired -> effective plan is Pro, but the permanent
      // workflow override still applies regardless.
      expect(plan.plan_id).toBe("pro");
      expect(plan.workflow_limit).toBe(7);
    } finally {
      await dropOrg(orgId);
    }
  });
});

describe("private.effective_plan() — personal (owner_id) workspace, real Postgres", () => {
  async function makeTestUser(): Promise<{ userId: string }> {
    const email = `effective-plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@nia-test.invalid`;
    const { rows } = await dbPool.query<{ id: string }>(
      `insert into public."user" (name, email) values ($1, $2) returning id`,
      ["effective plan test user", email],
    );
    return { userId: rows[0]!.id };
  }

  async function dropTestUser(userId: string): Promise<void> {
    await dbPool.query('delete from public."user" where id = $1', [userId]);
  }

  async function readEffectivePlanForUser(userId: string): Promise<EffectivePlanRow> {
    const { rows } = await dbPool.query<EffectivePlanRow>(
      `select plan_id, plan_name, workflow_limit, project_limit, copilot_actions_per_month, rows_per_month, rows_override_active, expired
         from private.effective_plan(null, $1)`,
      [userId],
    );
    return rows[0]!;
  }

  it("Pro base + expired grant reverts to Pro for an individual (owner_plan) workspace too", async () => {
    const { userId } = await makeTestUser();
    try {
      await dbPool.query(
        `update public.owner_plan
           set plan_id = 'pro', grant_plan_id = 'team', grant_expires_at = now() - interval '1 day'
         where user_id = $1`,
        [userId],
      );

      const plan = await readEffectivePlanForUser(userId);
      expect(plan.plan_id).toBe("pro");
      expect(plan.expired).toBe(true);
    } finally {
      await dropTestUser(userId);
    }
  });
});
