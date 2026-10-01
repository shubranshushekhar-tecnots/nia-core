import { Router, type Router as ExpressRouter } from "express";
import { withServiceRole } from "@nia/db";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { getSystemHealth } from "../services/consoleHealth.js";

/**
 * Console v2 Slice 4 — System Health page API. Same separate-router-file
 * convention as consoleUsage.ts/consoleDashboard.ts: mounted into
 * console.ts below the existing `.use(requireAuth, attachDb, requireStaff)`
 * call, so this inherits that auth chain without repeating it.
 */
export const consoleHealthRouter: ExpressRouter = Router();

/** GET /console/health — API/worker/queue/failed-runs/connector/migration status, one platform-wide read. */
consoleHealthRouter.get(
  "/health",
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const health = await withServiceRole(dbPool, async (db) => {
      const result = await getSystemHealth(db);
      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "health.read",
        null,
        null,
        JSON.stringify({}),
      ]);
      return result;
    });

    res.json(health);
  }),
);
