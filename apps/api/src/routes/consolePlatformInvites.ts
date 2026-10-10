import { randomBytes, createHash } from "node:crypto";
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
 * Email Phase 3 — Console "Invitations" screen API (staff-initiated direct
 * platform invites, public.platform_invites — distinct from the org-scoped
 * public.invite_links). Same separate-router-file convention as
 * consoleAccessRequests.ts/consoleStaff.ts, mounted into console.ts below
 * the existing auth chain.
 *
 * token_hash is one-way (sha256 of the raw token, same convention as
 * invite_links) — the raw token only ever exists in memory long enough to
 * build the email link, never persisted. So "resend" below cannot literally
 * resend the original link; it mints a fresh token on the same row (per the
 * migration's "resend reuses this same row instead of creating a new one")
 * and emails that instead, which also has the benefit of invalidating any
 * previously-leaked link.
 */
export const consolePlatformInvitesRouter: ExpressRouter = Router();

type PlatformInviteRow = {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "accepted" | "revoked";
  note: string | null;
  plan_id: string | null;
  grant_plan_id: string | null;
  grant_expires_at: string | null;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  created_at: string;
  updated_at: string;
};

function serializeInvite(row: PlatformInviteRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    expired: row.status === "pending" && new Date(row.expires_at) < new Date(),
    note: row.note,
    planId: row.plan_id,
    grantPlanId: row.grant_plan_id,
    grantExpiresAt: row.grant_expires_at,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedUserId: row.accepted_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const listQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "revoked"]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consolePlatformInvitesRouter.get(
  "/platform-invites",
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { status, search, limit = 50, offset = 0 } = req.query as unknown as {
      status?: "pending" | "accepted" | "revoked";
      search?: string;
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
      conditions.push(`(email ilike $${params.length} or name ilike $${params.length})`);
    }
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const countResult = await db.query<{ count: string }>(
        `select count(*) as count from public.platform_invites ${whereClause}`,
        params,
      );

      const limitParamIdx = params.length + 1;
      const offsetParamIdx = params.length + 2;
      const result = await db.query<PlatformInviteRow>(
        `select id, email, name, status, note, plan_id, grant_plan_id, grant_expires_at,
                invited_by, expires_at, accepted_at, accepted_user_id, created_at, updated_at
         from public.platform_invites
         ${whereClause}
         order by created_at desc
         limit $${limitParamIdx}
         offset $${offsetParamIdx}`,
        [...params, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "platform_invite.list",
        null,
        null,
        JSON.stringify({ status, search, limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      items: rows.map(serializeInvite),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

async function assertPlansExist(db: { query: (sql: string, params: unknown[]) => Promise<{ rows: { id: string }[] }> }, planId?: string, grantPlanId?: string | null) {
  if (planId) {
    const planExists = await db.query(`select id from public.plans where id = $1`, [planId]);
    if (!planExists.rows[0]) throw new AppError(400, "INVALID_PLAN", "Unknown plan id.");
  }
  if (grantPlanId) {
    const grantPlanExists = await db.query(`select id from public.plans where id = $1`, [grantPlanId]);
    if (!grantPlanExists.rows[0]) throw new AppError(400, "INVALID_PLAN", "Unknown grant plan id.");
  }
}

const createBodySchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(200).optional(),
  planId: z.string().trim().min(1).max(40).optional(),
  grantPlanId: z.string().trim().min(1).max(40).optional(),
  grantExpiresAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

consolePlatformInvitesRouter.post(
  "/platform-invites",
  validate({ body: createBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { email, name, planId, grantPlanId, grantExpiresAt, note } = req.body as unknown as {
      email: string;
      name?: string;
      planId?: string;
      grantPlanId?: string;
      grantExpiresAt?: string;
      note?: string;
    };

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const row = await withServiceRole(dbPool, async (db) => {
      await assertPlansExist(db, planId, grantPlanId);

      const existingPending = await db.query<{ id: string }>(
        `select id from public.platform_invites where lower(email) = lower($1) and status = 'pending'`,
        [email],
      );
      if (existingPending.rows[0]) {
        throw new AppError(409, "INVITE_ALREADY_PENDING", "This email already has a pending invite — use resend instead.");
      }

      const insertResult = await db.query<PlatformInviteRow>(
        `insert into public.platform_invites (email, name, token_hash, note, plan_id, grant_plan_id, grant_expires_at, invited_by)
         values (lower($1), $2, $3, $4, $5, $6, $7, $8)
         returning id, email, name, status, note, plan_id, grant_plan_id, grant_expires_at,
                   invited_by, expires_at, accepted_at, accepted_user_id, created_at, updated_at`,
        [email, name ?? null, tokenHash, note ?? null, planId ?? null, grantPlanId ?? null, grantExpiresAt ?? null, authUser.id],
      );
      const created = insertResult.rows[0]!;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "platform_invite.create",
        null,
        null,
        JSON.stringify({ platformInviteId: created.id, email, planId, grantPlanId }),
      ]);

      return created;
    });

    await enqueueEmail({
      kind: "send_email",
      to: row.email,
      payload: { template: "platformInvite", data: { name: row.name, acceptUrl: `${env.WEB_ORIGIN}/accept-invite/${rawToken}` } },
    });

    res.status(201).json(serializeInvite(row));
  }),
);

const idParamsSchema = z.object({ id: z.string().uuid() });

consolePlatformInvitesRouter.post(
  "/platform-invites/:id/resend",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { id } = req.params as unknown as { id: string };

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const row = await withServiceRole(dbPool, async (db) => {
      const beforeResult = await db.query<{ status: string }>(`select status from public.platform_invites where id = $1`, [id]);
      const before = beforeResult.rows[0];
      if (!before) return null;
      if (before.status !== "pending") {
        throw new AppError(400, "INVITE_NOT_PENDING", "Only a pending invite can be resent.");
      }

      const updateResult = await db.query<PlatformInviteRow>(
        `update public.platform_invites
         set token_hash = $2,
             expires_at = now() + interval '7 days',
             updated_at = now()
         where id = $1
         returning id, email, name, status, note, plan_id, grant_plan_id, grant_expires_at,
                   invited_by, expires_at, accepted_at, accepted_user_id, created_at, updated_at`,
        [id, tokenHash],
      );
      const after = updateResult.rows[0]!;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "platform_invite.resend",
        null,
        null,
        JSON.stringify({ platformInviteId: id, email: after.email }),
      ]);

      return after;
    });

    if (!row) throw new AppError(404, "NOT_FOUND", "Invitation not found.");

    await enqueueEmail({
      kind: "send_email",
      to: row.email,
      payload: { template: "platformInvite", data: { name: row.name, acceptUrl: `${env.WEB_ORIGIN}/accept-invite/${rawToken}` } },
    });

    res.json(serializeInvite(row));
  }),
);

consolePlatformInvitesRouter.post(
  "/platform-invites/:id/revoke",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { id } = req.params as unknown as { id: string };

    const row = await withServiceRole(dbPool, async (db) => {
      const beforeResult = await db.query<{ status: string; email: string }>(
        `select status, email from public.platform_invites where id = $1`,
        [id],
      );
      const before = beforeResult.rows[0];
      if (!before) return null;
      if (before.status !== "pending") {
        throw new AppError(400, "INVITE_NOT_PENDING", "Only a pending invite can be revoked.");
      }

      const updateResult = await db.query<PlatformInviteRow>(
        `update public.platform_invites
         set status = 'revoked', updated_at = now()
         where id = $1
         returning id, email, name, status, note, plan_id, grant_plan_id, grant_expires_at,
                   invited_by, expires_at, accepted_at, accepted_user_id, created_at, updated_at`,
        [id],
      );
      const after = updateResult.rows[0]!;

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "platform_invite.revoke",
        null,
        null,
        JSON.stringify({ platformInviteId: id, email: after.email }),
      ]);

      return after;
    });

    if (!row) throw new AppError(404, "NOT_FOUND", "Invitation not found.");
    res.json(serializeInvite(row));
  }),
);
