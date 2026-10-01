import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import {
  getUsageSummary,
  getUsageTimeseries,
  getUsageBreakdown,
  getTopConsumers,
  listModelPrices,
  createModelPrice,
  toCsv,
  type UsageFilters,
  type UsageBreakdownDimension,
} from "../services/usage.js";

/**
 * Console v2 Slice 4 — token usage + cost API. A separate router from
 * console.ts (already 1500+ lines) mounted into it below the existing
 * `.use(requireAuth, attachDb, requireStaff)` call, so every route here
 * inherits the exact same auth chain without repeating it — Express applies
 * middleware in registration order across the whole router stack regardless
 * of which file defines a given handler.
 *
 * Every route opens exactly one `withServiceRole` connection and writes
 * exactly one `staff_audit_log` row inside it (`private.log_staff_action`,
 * same convention as every route in console.ts) — these are read-only
 * aggregate views over a staff-only table, so there is no customer-facing
 * `audit_log` row to also write (unlike org.plan_update etc. in console.ts,
 * which also call `private.log_org_audit`).
 */
export const consoleUsageRouter: ExpressRouter = Router();

const usageFiltersQuerySchema = z.object({
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  orgId: z.string().uuid().optional(),
  model: z.string().trim().min(1).optional(),
  feature: z.string().trim().min(1).optional(),
});

function toFilters(query: Record<string, unknown>): UsageFilters {
  const { dateFrom, dateTo, orgId, model, feature } = query as {
    dateFrom?: string;
    dateTo?: string;
    orgId?: string;
    model?: string;
    feature?: string;
  };
  return { dateFrom, dateTo, orgId, model, feature };
}

/** GET /console/usage/summary — tokens + cost for today and the current month, optionally scoped to one org. */
consoleUsageRouter.get(
  "/usage/summary",
  validate({ query: usageFiltersQuerySchema.pick({ orgId: true }) }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { orgId } = req.query as unknown as { orgId?: string };

    const summary = await withServiceRole(dbPool, async (db) => {
      const result = await getUsageSummary(db, { orgId });
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "usage.summary_read",
        null,
        orgId ?? null,
        JSON.stringify({ orgId: orgId ?? null }),
      ]);
      return result;
    });

    res.json(summary);
  }),
);

/** GET /console/usage/timeseries — daily tokens + cost matching the given filters. */
consoleUsageRouter.get(
  "/usage/timeseries",
  validate({ query: usageFiltersQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const filters = toFilters(req.query as Record<string, unknown>);

    const points = await withServiceRole(dbPool, async (db) => {
      const result = await getUsageTimeseries(db, filters);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "usage.timeseries_read",
        null,
        filters.orgId ?? null,
        JSON.stringify({ ...filters, count: result.length }),
      ]);
      return result;
    });

    res.json({ points });
  }),
);

const breakdownQuerySchema = usageFiltersQuerySchema.extend({
  by: z.enum(["org", "user", "model", "feature"]),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/** GET /console/usage/breakdown?by=org|user|model|feature — tokens + cost grouped by the given dimension, ordered by cost desc. */
consoleUsageRouter.get(
  "/usage/breakdown",
  validate({ query: breakdownQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { by, limit = 20, ...rest } = req.query as unknown as { by: UsageBreakdownDimension; limit?: number } & UsageFilters;
    const filters = toFilters(rest as Record<string, unknown>);

    const rows = await withServiceRole(dbPool, async (db) => {
      const result = await getUsageBreakdown(db, by, filters, limit);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "usage.breakdown_read",
        null,
        filters.orgId ?? null,
        JSON.stringify({ by, ...filters, limit, count: result.length }),
      ]);
      return result;
    });

    res.json({ rows });
  }),
);

/** GET /console/usage/top-consumers — top orgs and top users by cost, matching filters. */
consoleUsageRouter.get(
  "/usage/top-consumers",
  validate({ query: usageFiltersQuerySchema.extend({ limit: z.coerce.number().int().positive().max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { limit = 10, ...rest } = req.query as unknown as { limit?: number } & UsageFilters;
    const filters = toFilters(rest as Record<string, unknown>);

    const result = await withServiceRole(dbPool, async (db) => {
      const consumers = await getTopConsumers(db, filters, limit);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "usage.top_consumers_read",
        null,
        filters.orgId ?? null,
        JSON.stringify({ ...filters, limit }),
      ]);
      return consumers;
    });

    res.json(result);
  }),
);

const exportQuerySchema = usageFiltersQuerySchema.extend({
  by: z.enum(["day", "org", "user", "model", "feature"]).optional(),
});

/** GET /console/usage/export — CSV export of the timeseries or a breakdown, matching filters. */
consoleUsageRouter.get(
  "/usage/export",
  validate({ query: exportQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { by = "day", ...rest } = req.query as unknown as { by?: "day" | UsageBreakdownDimension } & UsageFilters;
    const filters = toFilters(rest as Record<string, unknown>);

    const csv = await withServiceRole(dbPool, async (db) => {
      let body: string;
      if (by === "day") {
        const points = await getUsageTimeseries(db, filters);
        body = toCsv(points, ["date", "inputTokens", "outputTokens", "totalTokens", "cost"]);
      } else {
        const rows = await getUsageBreakdown(db, by, filters, 1000);
        body = toCsv(rows, ["key", "label", "inputTokens", "outputTokens", "totalTokens", "callCount", "cost"]);
      }

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "usage.export",
        null,
        filters.orgId ?? null,
        JSON.stringify({ by, ...filters }),
      ]);

      return body;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="llm-usage-${by}.csv"`);
    res.send(csv);
  }),
);

/** GET /console/model-prices?model= — full price history, optionally filtered to one model. */
consoleUsageRouter.get(
  "/model-prices",
  validate({ query: z.object({ model: z.string().trim().min(1).optional() }) }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { model } = req.query as unknown as { model?: string };

    const prices = await withServiceRole(dbPool, async (db) => {
      const result = await listModelPrices(db, model);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "model_price.list",
        null,
        null,
        JSON.stringify({ model: model ?? null, count: result.length }),
      ]);
      return result;
    });

    res.json({ prices });
  }),
);

const createModelPriceBodySchema = z.object({
  model: z.string().trim().min(1),
  inputPricePer1m: z.number().nonnegative(),
  outputPricePer1m: z.number().nonnegative(),
  cachedPricePer1m: z.number().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

/**
 * POST /console/model-prices — adds a new price row. Never an update: a
 * price correction is just a new row with a later effectiveFrom (history
 * kept, matching 0068_llm_usage.sql's own design intent for this table).
 */
consoleUsageRouter.post(
  "/model-prices",
  validate({ body: createModelPriceBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const input = req.body as z.infer<typeof createModelPriceBodySchema>;

    const price = await withServiceRole(dbPool, async (db) => {
      const result = await createModelPrice(db, input, authUser.id);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "model_price.create",
        null,
        null,
        JSON.stringify({ id: result.id, model: result.model, effectiveFrom: result.effectiveFrom }),
      ]);
      return result;
    });

    res.status(201).json(price);
  }),
);
