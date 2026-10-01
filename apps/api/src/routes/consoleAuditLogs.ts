import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";
import { toCsv } from "../services/usage.js";

/**
 * Console redesign plan's Slice 8 — Audit Logs page. Same separate-router-
 * file convention as consoleHealth.ts/consoleStaff.ts/consoleProjects.ts.
 *
 * Unions `staff_audit_log` (platform-side reads/actions) and `audit_log`
 * (org-side actions, e.g. suspend/plan-change/member-remove) into one feed,
 * each row tagged with its own `source`. The "staff member" filter applies
 * to `staff_audit_log.staff_user_id` on one side and `audit_log.actor` on
 * the other — same person, different column name per table (see
 * `buildFeedQuery` below). Reading this feed is itself a staff action, so
 * both `GET /audit-logs` and `GET /audit-logs/export` write their own
 * `staff_audit_log` row (`audit_logs.read` / `audit_logs.export`) — this
 * table audits reads of itself, same append-only table either way.
 */
export const consoleAuditLogsRouter: ExpressRouter = Router();

const auditLogFiltersQuerySchema = z.object({
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  orgId: z.string().uuid().optional(),
  staffUserId: z.string().uuid().optional(),
  action: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type AuditLogFilters = {
  dateFrom?: string;
  dateTo?: string;
  orgId?: string;
  staffUserId?: string;
  action?: string;
};

type AuditLogRow = {
  source: "staff" | "org";
  id: string;
  created_at: string;
  action: string;
  org_id: string | null;
  org_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  detail: unknown;
};

/**
 * Builds the shared UNION ALL feed query (without limit/offset) + its
 * params. `select` lets the two callers (list vs. count) wrap the same
 * filtered feed differently without duplicating the filter-building logic.
 */
function buildFeedQuery(filters: AuditLogFilters, select: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let i = 1;
  function p(value: unknown): string {
    params.push(value);
    return `$${i++}`;
  }

  const dateFromP = filters.dateFrom ? p(filters.dateFrom) : null;
  const dateToP = filters.dateTo ? p(filters.dateTo) : null;
  const orgIdP = filters.orgId ? p(filters.orgId) : null;
  const staffUserIdP = filters.staffUserId ? p(filters.staffUserId) : null;
  const actionP = filters.action ? p(`%${filters.action}%`) : null;

  const staffConditions = ["true"];
  if (dateFromP) staffConditions.push(`s.created_at >= ${dateFromP}`);
  if (dateToP) staffConditions.push(`s.created_at < ${dateToP}`);
  if (orgIdP) staffConditions.push(`s.org_id = ${orgIdP}`);
  if (staffUserIdP) staffConditions.push(`s.staff_user_id = ${staffUserIdP}`);
  if (actionP) staffConditions.push(`s.action ilike ${actionP}`);

  const orgConditions = ["true"];
  if (dateFromP) orgConditions.push(`a.created_at >= ${dateFromP}`);
  if (dateToP) orgConditions.push(`a.created_at < ${dateToP}`);
  if (orgIdP) orgConditions.push(`a.org_id = ${orgIdP}`);
  if (staffUserIdP) orgConditions.push(`a.actor = ${staffUserIdP}`);
  if (actionP) orgConditions.push(`a.action ilike ${actionP}`);

  const sql = `
    select ${select} from (
      select
        'staff' as source, s.id, s.created_at, s.action, s.org_id, o.name as org_name,
        s.staff_user_id as actor_id, coalesce(u.name, u.email) as actor_name, s.detail
      from public.staff_audit_log s
      left join public.organizations o on o.id = s.org_id
      left join public."user" u on u.id = s.staff_user_id
      where ${staffConditions.join(" and ")}
      union all
      select
        'org' as source, a.id, a.created_at, a.action, a.org_id, o2.name as org_name,
        a.actor as actor_id, coalesce(u2.name, u2.email) as actor_name, a.detail
      from public.audit_log a
      left join public.organizations o2 on o2.id = a.org_id
      left join public."user" u2 on u2.id = a.actor
      where ${orgConditions.join(" and ")}
    ) feed
  `;
  return { sql, params };
}

function parseFilters(query: Record<string, unknown>): AuditLogFilters {
  const { dateFrom, dateTo, orgId, staffUserId, action } = query as {
    dateFrom?: string;
    dateTo?: string;
    orgId?: string;
    staffUserId?: string;
    action?: string;
  };
  return { dateFrom, dateTo, orgId, staffUserId, action };
}

consoleAuditLogsRouter.get(
  "/audit-logs",
  validate({ query: auditLogFiltersQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { limit = 50, offset = 0 } = req.query as unknown as { limit?: number; offset?: number };
    const filters = parseFilters(req.query as Record<string, unknown>);

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const { sql: countSql, params: countParams } = buildFeedQuery(filters, "count(*) as count");
      const countResult = await db.query<{ count: string }>(countSql, countParams);

      const { sql: listSql, params: listParams } = buildFeedQuery(filters, "*");
      const limitP = `$${listParams.length + 1}`;
      const offsetP = `$${listParams.length + 2}`;
      const result = await db.query<AuditLogRow>(
        `${listSql} order by created_at desc, id desc limit ${limitP} offset ${offsetP}`,
        [...listParams, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "audit_logs.read",
        null,
        null,
        JSON.stringify({ ...filters, limit, offset }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      items: rows.map((row) => ({
        source: row.source,
        id: row.id,
        createdAt: row.created_at,
        action: row.action,
        orgId: row.org_id,
        orgName: row.org_name,
        actorId: row.actor_id,
        actorName: row.actor_name,
        detail: row.detail,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

/** GET /console/audit-logs/export — same filters as the list above, no pagination, returned as CSV. */
consoleAuditLogsRouter.get(
  "/audit-logs/export",
  validate({ query: auditLogFiltersQuerySchema.omit({ limit: true, offset: true }) }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const filters = parseFilters(req.query as Record<string, unknown>);

    const csv = await withServiceRole(dbPool, async (db) => {
      const { sql, params } = buildFeedQuery(filters, "*");
      const result = await db.query<AuditLogRow>(`${sql} order by created_at desc, id desc`, params);

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "audit_logs.export",
        null,
        null,
        JSON.stringify({ ...filters, count: result.rowCount }),
      ]);

      return toCsv(
        result.rows.map((row) => ({
          source: row.source,
          id: row.id,
          createdAt: row.created_at,
          action: row.action,
          orgId: row.org_id ?? "",
          orgName: row.org_name ?? "",
          actorId: row.actor_id ?? "",
          actorName: row.actor_name ?? "",
          detail: JSON.stringify(row.detail ?? {}),
        })),
        ["source", "id", "createdAt", "action", "orgId", "orgName", "actorId", "actorName", "detail"],
      );
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-logs.csv"`);
    res.send(csv);
  }),
);
