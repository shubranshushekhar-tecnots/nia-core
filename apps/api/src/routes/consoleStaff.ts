import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Console redesign plan's Slice 5 — Platform Staff page. Same separate-
 * router-file convention as consoleHealth.ts, mounted into console.ts below
 * the existing `.use(requireAuth, attachDb, requireStaff)` call.
 *
 * Read-only: staff are granted/revoked only via the manageStaff.ts CLI
 * (0039_platform_staff.sql), never via any HTTP route — this route only
 * lists who is currently staff. Revoked rows (`revoked_at is not null`) are
 * excluded, not shown de-emphasized, matching "who is staff today."
 *
 * Session metadata follows the exact same allowlist discipline as
 * `GET /console/users/:userId` — only `session."createdAt"` (most recent),
 * never `session.token`.
 */
export const consoleStaffRouter: ExpressRouter = Router();

const listStaffQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consoleStaffRouter.get(
  "/staff",
  validate({ query: listStaffQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { limit = 50, offset = 0 } = req.query as unknown as { limit?: number; offset?: number };

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const countResult = await db.query<{ count: string }>(
        `select count(*) as count from public.platform_staff where revoked_at is null`,
      );

      const result = await db.query<{
        user_id: string;
        name: string;
        email: string;
        two_factor_enabled: boolean;
        granted_by_name: string;
        granted_by_email: string;
        granted_at: string;
        last_sign_in_at: string | null;
      }>(
        `select
           ps.user_id,
           u.name,
           u.email,
           u."twoFactorEnabled" as two_factor_enabled,
           gb.name as granted_by_name,
           gb.email as granted_by_email,
           ps.granted_at,
           (select max(s."createdAt") from public."session" s where s."userId" = ps.user_id) as last_sign_in_at
         from public.platform_staff ps
         join public."user" u on u.id = ps.user_id
         join public."user" gb on gb.id = ps.granted_by
         where ps.revoked_at is null
         order by ps.granted_at asc
         limit $1
         offset $2`,
        [limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "staff.list",
        null,
        null,
        JSON.stringify({ limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      staff: rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        twoFactorEnabled: row.two_factor_enabled,
        grantedBy: { name: row.granted_by_name, email: row.granted_by_email },
        grantedAt: row.granted_at,
        lastSignInAt: row.last_sign_in_at,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);
