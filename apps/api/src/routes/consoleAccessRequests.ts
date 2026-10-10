import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { enqueueEmail } from "../lib/mailQueue.js";
import { env } from "../env.js";

/**
 * Email Phase 3 — Console "Access requests" screen API. Same separate-
 * router-file convention as consoleStaff.ts, mounted into console.ts below
 * the existing `.use(requireAuth, attachDb, requireStaff)` call. Backs the
 * public /request-access form's review queue: staff approve (optionally
 * attaching a plan/grant) or reject a pending row; both actions are
 * audited and email the requester.
 */
export const consoleAccessRequestsRouter: ExpressRouter = Router();

type AccessRequestRow = {
  id: string;
  email: string;
  full_name: string;
  company: string;
  job_role: string | null;
  use_case: string;
  data_sources: string[];
  referral_source: string | null;
  status: "pending" | "approved" | "rejected";
  rejected_reason: string | null;
  plan_id: string | null;
  grant_plan_id: string | null;
  grant_expires_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  signed_up_user_id: string | null;
  created_at: string;
  updated_at: string;
};

function serializeAccessRequest(row: AccessRequestRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    company: row.company,
    jobRole: row.job_role,
    useCase: row.use_case,
    dataSources: row.data_sources,
    referralSource: row.referral_source,
    status: row.status,
    rejectedReason: row.rejected_reason,
    planId: row.plan_id,
    grantPlanId: row.grant_plan_id,
    grantExpiresAt: row.grant_expires_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    signedUpUserId: row.signed_up_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Email Phase 3: backs ConsoleShell's nav badge, called on every /console/*
// page render — deliberately separate from the list route below (which
// writes an `access_request.list` staff_audit_log row per call). A badge
// count isn't a staff "action" worth auditing, and logging it on every
// page view would spam the audit trail with noise unrelated to what the
// staff member actually did.
consoleAccessRequestsRouter.get(
  "/access-requests/pending-count",
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const count = await withServiceRole(dbPool, async (db) => {
      const result = await db.query<{ count: string }>(
        "select count(*) as count from public.access_requests where status = 'pending'",
      );
      return Number(result.rows[0]?.count ?? 0);
    });

    res.json({ count });
  }),
);

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consoleAccessRequestsRouter.get(
  "/access-requests",
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { status, search, dateFrom, dateTo, limit = 50, offset = 0 } = req.query as unknown as {
      status?: "pending" | "approved" | "rejected";
      search?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
      offset?: number;
    };

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(email ilike $${params.length} or full_name ilike $${params.length} or company ilike $${params.length})`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at <= $${params.length}`);
    }
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const countResult = await db.query<{ count: string }>(
        `select count(*) as count from public.access_requests ${whereClause}`,
        params,
      );

      const limitParamIdx = params.length + 1;
      const offsetParamIdx = params.length + 2;
      const result = await db.query<AccessRequestRow>(
        `select id, email, full_name, company, job_role, use_case, data_sources, referral_source,
                status, rejected_reason, plan_id, grant_plan_id, grant_expires_at,
                reviewed_by, reviewed_at, signed_up_user_id, created_at, updated_at
         from public.access_requests
         ${whereClause}
         order by created_at desc
         limit $${limitParamIdx}
         offset $${offsetParamIdx}`,
        [...params, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "access_request.list",
        null,
        null,
        JSON.stringify({ status, search, dateFrom, dateTo, limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      items: rows.map(serializeAccessRequest),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

const idParamsSchema = z.object({ id: z.string().uuid() });

consoleAccessRequestsRouter.get(
  "/access-requests/:id",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { id } = req.params as unknown as { id: string };

    const row = await withServiceRole(dbPool, async (db) => {
      const result = await db.query<AccessRequestRow>(
        `select id, email, full_name, company, job_role, use_case, data_sources, referral_source,
                status, rejected_reason, plan_id, grant_plan_id, grant_expires_at,
                reviewed_by, reviewed_at, signed_up_user_id, created_at, updated_at
         from public.access_requests where id = $1`,
        [id],
      );
      const found = result.rows[0];
      if (!found) return null;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "access_request.read",
        null,
        null,
        JSON.stringify({ accessRequestId: id }),
      ]);

      return found;
    });

    if (!row) throw new AppError(404, "NOT_FOUND", "Access request not found.");
    res.json(serializeAccessRequest(row));
  }),
);

const approveBodySchema = z.object({
  planId: z.string().trim().min(1).max(40).optional(),
  grantPlanId: z.string().trim().min(1).max(40).nullable().optional(),
  grantExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

consoleAccessRequestsRouter.patch(
  "/access-requests/:id/approve",
  validate({ params: idParamsSchema, body: approveBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { id } = req.params as unknown as { id: string };
    const { planId, grantPlanId = null, grantExpiresAt = null } = req.body as unknown as {
      planId?: string;
      grantPlanId?: string | null;
      grantExpiresAt?: string | null;
    };

    const row = await withServiceRole(dbPool, async (db) => {
      if (planId) {
        const planExists = await db.query<{ id: string }>(`select id from public.plans where id = $1`, [planId]);
        if (!planExists.rows[0]) throw new AppError(400, "INVALID_PLAN", "Unknown plan id.");
      }
      if (grantPlanId !== null) {
        const grantPlanExists = await db.query<{ id: string }>(`select id from public.plans where id = $1`, [grantPlanId]);
        if (!grantPlanExists.rows[0]) throw new AppError(400, "INVALID_PLAN", "Unknown grant plan id.");
      }

      const beforeResult = await db.query<{ status: string; email: string }>(
        `select status, email from public.access_requests where id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) return null;

      const updateResult = await db.query<AccessRequestRow>(
        `update public.access_requests
         set status = 'approved',
             rejected_reason = null,
             plan_id = coalesce($2, plan_id),
             grant_plan_id = $3,
             grant_expires_at = $4,
             reviewed_by = $5,
             reviewed_at = now(),
             updated_at = now()
         where id = $1
         returning id, email, full_name, company, job_role, use_case, data_sources, referral_source,
                   status, rejected_reason, plan_id, grant_plan_id, grant_expires_at,
                   reviewed_by, reviewed_at, signed_up_user_id, created_at, updated_at`,
        [id, planId ?? null, grantPlanId, grantExpiresAt, authUser.id],
      );
      const after = updateResult.rows[0]!;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "access_request.approve",
        null,
        null,
        JSON.stringify({ accessRequestId: id, before: before.status, after: "approved", planId, grantPlanId, grantExpiresAt }),
      ]);

      return after;
    });

    if (!row) throw new AppError(404, "NOT_FOUND", "Access request not found.");

    await enqueueEmail({
      kind: "send_email",
      to: row.email,
      payload: { template: "accessRequestApproved", data: { signInUrl: `${env.WEB_ORIGIN}/signup` } },
    });

    res.json(serializeAccessRequest(row));
  }),
);

const rejectBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

consoleAccessRequestsRouter.patch(
  "/access-requests/:id/reject",
  validate({ params: idParamsSchema, body: rejectBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { id } = req.params as unknown as { id: string };
    const { reason } = req.body as unknown as { reason?: string };

    const row = await withServiceRole(dbPool, async (db) => {
      const beforeResult = await db.query<{ status: string; email: string }>(
        `select status, email from public.access_requests where id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) return null;

      const updateResult = await db.query<AccessRequestRow>(
        `update public.access_requests
         set status = 'rejected',
             rejected_reason = $2,
             reviewed_by = $3,
             reviewed_at = now(),
             updated_at = now()
         where id = $1
         returning id, email, full_name, company, job_role, use_case, data_sources, referral_source,
                   status, rejected_reason, plan_id, grant_plan_id, grant_expires_at,
                   reviewed_by, reviewed_at, signed_up_user_id, created_at, updated_at`,
        [id, reason ?? null, authUser.id],
      );
      const after = updateResult.rows[0]!;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "access_request.reject",
        null,
        null,
        JSON.stringify({ accessRequestId: id, before: before.status, after: "rejected", reason }),
      ]);

      return after;
    });

    if (!row) throw new AppError(404, "NOT_FOUND", "Access request not found.");

    await enqueueEmail({
      kind: "send_email",
      to: row.email,
      payload: { template: "accessRequestRejected", data: { reasonText: reason } },
    });

    res.json(serializeAccessRequest(row));
  }),
);
