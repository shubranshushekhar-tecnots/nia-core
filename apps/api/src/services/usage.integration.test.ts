import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withServiceRole } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { getUsageSummary, getUsageTimeseries, getUsageBreakdown, listModelPrices, createModelPrice } from "./usage.js";

/**
 * Console v2 Slice 4, two of the task's mandatory tests:
 * - "cost uses the price effective at call time (price change mid-period)"
 * - "no content columns exist" (asserted against the real information_schema,
 *   not just this file's own query list, so it fails if a future migration
 *   ever adds one).
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL), same convention
 * as dashboard.integration.test.ts. Run explicitly with `pnpm test:integration`.
 */

afterAll(async () => {
  await dbPool.end();
});

const insertedOrgIds: string[] = [];
const insertedPriceIds: string[] = [];

afterEach(async () => {
  if (insertedOrgIds.length > 0) {
    await dbPool.query("delete from public.organizations where id = any($1::uuid[])", [insertedOrgIds]);
    insertedOrgIds.length = 0;
  }
  if (insertedPriceIds.length > 0) {
    await dbPool.query("delete from public.model_prices where id = any($1::uuid[])", [insertedPriceIds]);
    insertedPriceIds.length = 0;
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
