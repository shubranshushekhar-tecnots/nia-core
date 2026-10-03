import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withActingUser, withServiceRole } from "@nia/db";
import type { Queryable } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { auth } from "../lib/auth.js";
import { getUsageSummary, getUsageTimeseries, getUsageBreakdown, listModelPrices, createModelPrice } from "./usage.js";
import { assertCopilotActionAllowed } from "./chat.js";

/**
 * Console v2 Slice 4, two of the task's mandatory tests:
 * - "cost uses the price effective at call time (price change mid-period)"
 * - "no content columns exist" (asserted against the real information_schema,
 *   not just this file's own query list, so it fails if a future migration
 *   ever adds one).
 *
 * Also covers the chat-500-on-usage_events fix: assertCopilotActionAllowed
 * (apps/api/src/services/chat.ts) previously ran its advisory lock + plan/
 * usage check + insert as `authenticated` (via withUser), which can never
 * succeed since 0066_usage_events.sql grants `authenticated` select only —
 * every real chat request failed with 42501. Fixed to run that whole
 * section atomically as service_role, still explicitly scoped by the
 * caller-supplied (session-verified) org/owner id.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL), same convention
 * as dashboard.integration.test.ts. Run explicitly with `pnpm test:integration`.
 */

afterAll(async () => {
  await dbPool.end();
});

const insertedOrgIds: string[] = [];
const insertedPriceIds: string[] = [];
const insertedUserIds: string[] = [];

afterEach(async () => {
  if (insertedOrgIds.length > 0) {
    const orgIds = [...insertedOrgIds];
    await dbPool.query("delete from public.organizations where id = any($1::uuid[])", [orgIds]);
    // usage_events.org_id references organizations(id) on delete cascade
    // (0066_usage_events.sql), so the delete above should already have
    // removed every usage_events row these tests created. Verify it,
    // rather than assume it — stop loudly instead of silently leaving
    // usage_events rows behind if cleanup ever didn't work.
    const { rows: leftoverUsage } = await dbPool.query<{ id: string }>(
      "select id from public.usage_events where org_id = any($1::uuid[])",
      [orgIds],
    );
    if (leftoverUsage.length > 0) {
      throw new Error(
        `Cleanup failed: ${leftoverUsage.length} usage_events row(s) still exist for test org(s) ${orgIds.join(", ")} after deleting the organization(s) — stopping rather than leaving rows behind.`,
      );
    }
    insertedOrgIds.length = 0;
  }
  if (insertedPriceIds.length > 0) {
    await dbPool.query("delete from public.model_prices where id = any($1::uuid[])", [insertedPriceIds]);
    insertedPriceIds.length = 0;
  }
  if (insertedUserIds.length > 0) {
    await dbPool.query('delete from public."user" where id = any($1::uuid[])', [insertedUserIds]);
    insertedUserIds.length = 0;
  }
});

async function makeFixtureOrg(): Promise<{ orgId: string; userId: string }> {
  const { rows: userRows } = await dbPool.query<{ id: string }>('select id from public."user" limit 1');
  const userId = userRows[0]!.id;

  const { rows: orgRows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    ["usage service test org", `usage-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`, userId],
  );
  const orgId = orgRows[0]!.id;
  insertedOrgIds.push(orgId);
  return { orgId, userId };
}

/** Same as makeFixtureOrg, but also adds the fixture user as an actual 'member' row (organization_members), for the assertCopilotActionAllowed tests below. */
async function makeFixtureOrgWithMember(): Promise<{ orgId: string; userId: string }> {
  const { orgId, userId } = await makeFixtureOrg();
  await dbPool.query(
    "insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'member')",
    [orgId, userId],
  );
  return { orgId, userId };
}

/** A real, freshly signed-up user who is deliberately never added to any fixture org's organization_members. */
async function makeStrangerUser(): Promise<string> {
  const email = `usage-copilot-stranger-${Date.now()}-${Math.random().toString(36).slice(2)}@nia.dev`;
  const result = await auth.api.signUpEmail({ body: { email, password: "password", name: "usage copilot stranger" } });
  insertedUserIds.push(result.user.id);
  return result.user.id;
}

async function countUsageEvents(orgId: string): Promise<number> {
  const { rows } = await dbPool.query<{ count: string }>(
    "select count(*)::bigint as count from public.usage_events where org_id = $1 and kind = 'copilot_action'",
    [orgId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function fillCopilotUsage(orgId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await dbPool.query(
      `insert into public.usage_events (org_id, kind, quantity, subject_id) values ($1, 'copilot_action', 1, $2)`,
      [orgId, randomUUID()],
    );
  }
}

async function insertUsageRow(params: {
  orgId: string;
  occurredAt: string;
  model: string;
  feature?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): Promise<void> {
  await dbPool.query(
    `insert into public.llm_usage
       (occurred_at, org_id, feature, model, input_tokens, output_tokens, total_tokens, latency_ms, status)
     values ($1, $2, $3, $4, $5, $6, $7, 100, 'ok')`,
    [
      params.occurredAt,
      params.orgId,
      params.feature ?? "copilot_agent",
      params.model,
      params.inputTokens ?? 1000,
      params.outputTokens ?? 500,
      params.totalTokens ?? (params.inputTokens ?? 1000) + (params.outputTokens ?? 500),
    ],
  );
}

async function insertPrice(params: {
  model: string;
  effectiveFrom: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
}): Promise<void> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.model_prices (model, input_price_per_1m, output_price_per_1m, effective_from)
     values ($1, $2, $3, $4) returning id`,
    [params.model, params.inputPricePer1m, params.outputPricePer1m, params.effectiveFrom],
  );
  insertedPriceIds.push(rows[0]!.id);
}

describe("llm_usage — no content columns (mandatory)", () => {
  it("has no prompt/response/content-like column, by schema introspection", async () => {
    const { rows } = await dbPool.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'llm_usage'`,
    );
    const columnNames = rows.map((r) => r.column_name).sort();
    expect(columnNames).toEqual(
      [
        "id",
        "occurred_at",
        "org_id",
        "owner_user_id",
        "user_id",
        "workflow_id",
        "run_id",
        "feature",
        "model",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "total_tokens",
        "latency_ms",
        "status",
        "usage_known",
        "error_code",
      ].sort(),
    );
    for (const name of columnNames) {
      expect(name).not.toMatch(/prompt|response|content|message|message_text/i);
    }
  });
});

describe("getUsageSummary / getUsageTimeseries / getUsageBreakdown — cost at effective price (mandatory)", () => {
  it("uses the price effective at each call's occurred_at, not today's price, across a mid-period price change", async () => {
    const { orgId } = await makeFixtureOrg();
    const model = `test-model-${Date.now()}`;

    // Price A effective from the start of this month; price B (a change)
    // effective from a date in the middle of the month.
    await insertPrice({ model, effectiveFrom: "2020-01-01T00:00:00Z", inputPricePer1m: 1, outputPricePer1m: 2 });
    await insertPrice({ model, effectiveFrom: "2024-06-15T00:00:00Z", inputPricePer1m: 10, outputPricePer1m: 20 });

    // One call before the price change (uses price A), one call after (uses price B).
    await insertUsageRow({ orgId, occurredAt: "2024-06-01T00:00:00Z", model, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    await insertUsageRow({ orgId, occurredAt: "2024-06-20T00:00:00Z", model, inputTokens: 1_000_000, outputTokens: 1_000_000 });

    const rows = await withServiceRole(dbPool, (db) =>
      getUsageBreakdown(db, "org", { orgId, dateFrom: "2024-06-01T00:00:00Z", dateTo: "2024-07-01T00:00:00Z" }, 10),
    );

    const row = rows.find((r) => r.key === orgId);
    expect(row).toBeTruthy();
    // Before-change call: 1*1 + 1*2 = 3. After-change call: 1*10 + 1*20 = 30. Total = 33, not 60 (both at new price) or 6 (both at old price).
    expect(row!.cost).toBeCloseTo(33, 5);
  });

  it("getUsageTimeseries groups by day and applies the same effective-price rule", async () => {
    const { orgId } = await makeFixtureOrg();
    const model = `test-model-ts-${Date.now()}`;

    await insertPrice({ model, effectiveFrom: "2020-01-01T00:00:00Z", inputPricePer1m: 5, outputPricePer1m: 5 });
    await insertUsageRow({ orgId, occurredAt: "2024-03-10T12:00:00Z", model, inputTokens: 1_000_000, outputTokens: 0 });

    const points = await withServiceRole(dbPool, (db) =>
      getUsageTimeseries(db, { orgId, dateFrom: "2024-03-01T00:00:00Z", dateTo: "2024-04-01T00:00:00Z" }),
    );

    const point = points.find((p) => p.date === "2024-03-10");
    expect(point).toBeTruthy();
    expect(point!.inputTokens).toBe(1_000_000);
    expect(point!.cost).toBeCloseTo(5, 5);
  });

  it("getUsageSummary scopes today/month totals to the given org", async () => {
    const { orgId } = await makeFixtureOrg();
    const model = `test-model-summary-${Date.now()}`;
    await insertPrice({ model, effectiveFrom: "2020-01-01T00:00:00Z", inputPricePer1m: 1, outputPricePer1m: 1 });
    await insertUsageRow({ orgId, occurredAt: new Date().toISOString(), model, inputTokens: 100, outputTokens: 100 });

    const summary = await withServiceRole(dbPool, (db) => getUsageSummary(db, { orgId }));
    expect(summary.today.totalTokens).toBeGreaterThanOrEqual(200);
    expect(summary.month.totalTokens).toBeGreaterThanOrEqual(200);
  });
});

describe("model price catalog — create/list round trip", () => {
  it("createModelPrice then listModelPrices returns the new row, history kept (no update path)", async () => {
    const { userId } = await makeFixtureOrg();
    const model = `test-model-crud-${Date.now()}`;

    const created = await withServiceRole(dbPool, (db) =>
      createModelPrice(db, { model, inputPricePer1m: 3, outputPricePer1m: 6 }, userId),
    );
    insertedPriceIds.push(created.id);

    const list = await withServiceRole(dbPool, (db) => listModelPrices(db, model));
    expect(list).toHaveLength(1);
    expect(list[0]!.inputPricePer1m).toBe(3);
    expect(list[0]!.outputPricePer1m).toBe(6);

    // A "correction" is a new row with a later effective_from, not an update.
    const corrected = await withServiceRole(dbPool, (db) =>
      createModelPrice(db, { model, inputPricePer1m: 4, outputPricePer1m: 7 }, userId),
    );
    insertedPriceIds.push(corrected.id);

    const listAfter = await withServiceRole(dbPool, (db) => listModelPrices(db, model));
    expect(listAfter).toHaveLength(2);
  });
});

describe("assertCopilotActionAllowed — chat 500-on-usage_events fix, real Postgres grants", () => {
  it("a member under the limit: the call succeeds and records exactly one usage_events row for the right org", async () => {
    const { orgId } = await makeFixtureOrgWithMember();
    const subjectId = randomUUID();

    await expect(assertCopilotActionAllowed(dbPool, { orgId }, subjectId)).resolves.toBeUndefined();

    const { rows } = await dbPool.query<{ org_id: string; kind: string; subject_id: string }>(
      "select org_id, kind, subject_id from public.usage_events where subject_id = $1",
      [subjectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgId);
    expect(rows[0]!.kind).toBe("copilot_action");
  });

  it("never blocks an unmetered plan (copilot_actions_per_month null) but still records usage for Console visibility", async () => {
    const { orgId } = await makeFixtureOrgWithMember();
    await dbPool.query("update public.org_plan set plan_id = 'legacy' where org_id = $1", [orgId]);
    await fillCopilotUsage(orgId, 999); // Far past any metered limit — must still be allowed since legacy is unmetered.
    const subjectId = randomUUID();

    await expect(assertCopilotActionAllowed(dbPool, { orgId }, subjectId)).resolves.toBeUndefined();

    const { rows } = await dbPool.query<{ id: string }>(
      "select id from public.usage_events where subject_id = $1",
      [subjectId],
    );
    expect(rows).toHaveLength(1);
  });

  it("at the limit: the call is refused with COPILOT_LIMIT_EXCEEDED and no new usage_events row is recorded", async () => {
    const { orgId } = await makeFixtureOrgWithMember();
    // Free plan (this org's default, 0043's create trigger) = 50 copilot_actions_per_month.
    await fillCopilotUsage(orgId, 50);
    const subjectId = randomUUID();

    await expect(assertCopilotActionAllowed(dbPool, { orgId }, subjectId)).rejects.toMatchObject({
      statusCode: 403,
      code: "COPILOT_LIMIT_EXCEEDED",
    });

    const { rows } = await dbPool.query<{ id: string }>(
      "select id from public.usage_events where subject_id = $1",
      [subjectId],
    );
    expect(rows).toHaveLength(0);
    expect(await countUsageEvents(orgId)).toBe(50);
  });

  it("a direct insert into usage_events as authenticated is still denied (42501) — the root cause this fix addresses", async () => {
    const { orgId, userId } = await makeFixtureOrgWithMember();
    const withUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> => withActingUser(dbPool, userId, fn);

    await expect(
      withUser((db) =>
        db.query(
          `insert into public.usage_events (org_id, kind, quantity, subject_id) values ($1, 'copilot_action', 1, $2)`,
          [orgId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    expect(await countUsageEvents(orgId)).toBe(0);
  });

  it("two parallel calls at one below the limit: exactly one is allowed, the other is refused, and exactly one new row is recorded", async () => {
    const { orgId } = await makeFixtureOrgWithMember();
    await fillCopilotUsage(orgId, 49); // Free plan limit is 50 — one slot remains.

    const results = await Promise.allSettled([
      assertCopilotActionAllowed(dbPool, { orgId }, randomUUID()),
      assertCopilotActionAllowed(dbPool, { orgId }, randomUUID()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "COPILOT_LIMIT_EXCEEDED" });
    expect(await countUsageEvents(orgId)).toBe(50);
  });

  it("a user who does not belong to an org cannot cause usage to be recorded against it", async () => {
    const { orgId } = await makeFixtureOrgWithMember();
    const strangerId = await makeStrangerUser();

    // The real boundary: attachActor (middleware/actor.ts) resolves scope
    // from organization_members rows for the authenticated user's own id —
    // a stranger has none for this org, so scopeFromActor could never
    // produce { orgId } for them in the first place.
    const { rows: membershipRows } = await dbPool.query(
      "select 1 from public.organization_members where org_id = $1 and user_id = $2",
      [orgId, strangerId],
    );
    expect(membershipRows).toHaveLength(0);

    // Defense in depth: even a direct attempt to write into usage_events
    // for that org as the stranger (bypassing assertCopilotActionAllowed
    // entirely) is denied by the same unconditional grant-level block
    // proven above — membership is irrelevant, `authenticated` has no
    // insert grant on usage_events at all.
    const strangerWithUser = <T>(fn: (db: Queryable) => Promise<T>): Promise<T> =>
      withActingUser(dbPool, strangerId, fn);
    await expect(
      strangerWithUser((db) =>
        db.query(
          `insert into public.usage_events (org_id, kind, quantity, subject_id) values ($1, 'copilot_action', 1, $2)`,
          [orgId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    expect(await countUsageEvents(orgId)).toBe(0);
  });
});
