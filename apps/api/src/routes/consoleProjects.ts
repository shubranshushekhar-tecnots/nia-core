import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Console redesign plan's Slice 6 — Projects & Workflows page. Same
 * separate-router-file convention as consoleHealth.ts/consoleStaff.ts.
 *
 * Per-org rollup only — project count, workflow count, and the most recent
 * run's status/time across that org's workflows (via a `left join lateral`
 * so the aggregate counts don't fan out against the one-row-per-run join).
 * Explicit column allowlist: no `select *`, and deliberately no workflow
 * `definition`/content column anywhere in this query — this page is a
 * cross-org operational rollup, not a way to read any org's workflow
 * content, per the plan's "no workflow content or row data" requirement.
 */
export const consoleProjectsRouter: ExpressRouter = Router();

const listProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consoleProjectsRouter.get(
  "/projects",
  validate({ query: listProjectsQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { limit = 50, offset = 0 } = req.query as unknown as { limit?: number; offset?: number };

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const countResult = await db.query<{ count: string }>(`select count(*) as count from public.organizations`);

      const result = await db.query<{
        org_id: string;
        org_name: string;
        project_count: string;
        workflow_count: string;
        last_run_status: string | null;
        last_run_started_at: string | null;
      }>(
        `select
           o.id as org_id,
           o.name as org_name,
           (select count(*) from public.projects p where p.org_id = o.id) as project_count,
           (select count(*) from public.workflows w where w.org_id = o.id) as workflow_count,
           lr.status as last_run_status,
           lr.started_at as last_run_started_at
         from public.organizations o
         left join lateral (
           select r.status, r.started_at
           from public.workflow_runs r
           where r.org_id = o.id
           order by r.started_at desc
           limit 1
         ) lr on true
         order by o.created_at desc
         limit $1
         offset $2`,
        [limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "projects.list",
        null,
        null,
        JSON.stringify({ limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      orgs: rows.map((row) => ({
        orgId: row.org_id,
        orgName: row.org_name,
        projectCount: Number(row.project_count),
        workflowCount: Number(row.workflow_count),
        lastRun:
          row.last_run_status === null
            ? null
            : { status: row.last_run_status, startedAt: row.last_run_started_at },
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);
