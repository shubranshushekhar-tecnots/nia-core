import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { getDashboardOverview, getRunsPerDay, getRowsMovedTotals, getNeedsAttention } from "../services/consoleDashboard.js";

/**
 * Console v2 Slice 6 — platform dashboard API. Same separate-router-file
 * convention as consoleUsage.ts (Slice 4): mounted into console.ts below the
 * existing `.use(requireAuth, attachDb, requireStaff)` call, so every route
 * here inherits that auth chain without repeating it.
 *
 * Every route opens exactly one `withServiceRole` connection and writes
 * exactly one `staff_audit_log` row inside it — these are read-only
 * aggregate views over platform-wide data (no single org/user is the
 * "subject", so both audit args are null), same convention as every
 * cross-org read already in console.ts (GET /orgs) and consoleUsage.ts.
 */
export const consoleDashboardRouter: ExpressRouter = Router();

/** GET /console/dashboard/overview — total orgs, total users, active users (last 30 days). */
consoleDashboardRouter.get(
  "/dashboard/overview",
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const overview = await withServiceRole(dbPool, async (db) => {
      const result = await getDashboardOverview(db);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "dashboard.overview_read",
        null,
        null,
        JSON.stringify({}),
      ]);
      return result;
    });

    res.json(overview);
  }),
);

const daysQuerySchema = z.object({ days: z.coerce.number().int().positive().max(365).optional() });

/** GET /console/dashboard/runs-per-day?days= — cross-org daily run counts (ok/failed/running) + rows processed. Defaults to 30 days. */
consoleDashboardRouter.get(
  "/dashboard/runs-per-day",
  validate({ query: daysQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { days = 30 } = req.query as unknown as { days?: number };

    const points = await withServiceRole(dbPool, async (db) => {
      const result = await getRunsPerDay(db, days);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "dashboard.runs_per_day_read",
        null,
        null,
        JSON.stringify({ days, count: result.length }),
      ]);
      return result;
    });

    res.json({ points });
  }),
);

/** GET /console/dashboard/rows-moved — cross-org rows-moved totals (all-time + last 30 days). */
consoleDashboardRouter.get(
  "/dashboard/rows-moved",
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const totals = await withServiceRole(dbPool, async (db) => {
      const result = await getRowsMovedTotals(db);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "dashboard.rows_moved_read",
        null,
        null,
        JSON.stringify({}),
      ]);
      return result;
    });

    res.json(totals);
  }),
);

const needsAttentionQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(50).optional() });

/** GET /console/dashboard/needs-attention?limit= — suspended orgs, orgs near their workflow limit, orgs with recent failing runs. */
consoleDashboardRouter.get(
  "/dashboard/needs-attention",
  validate({ query: needsAttentionQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { limit = 10 } = req.query as unknown as { limit?: number };

    const items = await withServiceRole(dbPool, async (db) => {
      const result = await getNeedsAttention(db, limit);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "dashboard.needs_attention_read",
        null,
        null,
        JSON.stringify({ limit, count: result.length }),
      ]);
      return result;
    });

    res.json({ items });
  }),
);
