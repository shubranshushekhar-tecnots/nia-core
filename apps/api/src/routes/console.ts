import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { withServiceRole } from "@nia/db";
import { requireAuth } from "../middleware/auth.js";
import { attachDb } from "../middleware/db.js";
import { requireStaff } from "../middleware/requireStaff.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Console v1 (docs/plans/console-plan.md, build order step 4). Mounted at
 * "/console" only when env.CONSOLE_ENABLED is true (see index.ts) — empty
 * besides GET /ping, a trivial route that exists purely to prove the
 * requireAuth -> attachDb -> requireStaff chain (§3's exact middleware
 * order for every future /console/* route) actually gates access end to
 * end, before any real capability is built on top of it in later steps.
 *
 * attachDb is wired in now (unused by /ping itself) so every subsequent
 * route added in steps 5+ can rely on req.withUser already being set by
 * this router's own .use(), matching §3's spec exactly rather than adding
 * it piecemeal later.
 *
 * /ping does not write a staff_audit_log row — §3's "every GET writes one
 * staff_audit_log row per org/user touched" applies to routes that actually
 * read org/user data (steps 5+), not this liveness/gate check, which
 * touches no resource.
 */
export const consoleRouter: ExpressRouter = Router();

consoleRouter.use(requireAuth, attachDb, requireStaff);

consoleRouter.get("/ping", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Build order step 5 / Slice 1 (console-plan.md §3, §5). List/search orgs
 * for the Directory screen.
 *
 * Reads via `withServiceRole`, not `req.withUser`: `organizations` has RLS
 * scoped to `private.is_member(id)` (0001_auth_orgs.sql), so a staff
 * member's own `req.withUser` query would only ever see the orgs *they*
 * personally belong to, not the platform-wide list this screen needs. This
 * is the same narrow, deliberate exception `requireStaff.ts` already
 * documents for the `platform_staff` check: every route on this router has
 * already passed `requireStaff` before reaching here, so the cross-org read
 * is gated on staff membership rather than being a general RLS bypass, and
 * it is scoped to `organizations` + `organization_members` + a
 * `workflow_runs` count — no secrets, no result-row customer data.
 *
 * `plan_tier` is still hardcoded below (`org_plan`, build step 7, is not
 * joined into this list query — GET /orgs/:orgId does join it, for the
 * per-org detail read). `status` is now real: build step 9 (Slice 3b) added
 * `organizations.suspended_at`, so a suspended org's `status` reflects it
 * instead of the old always-'Active' placeholder.
 *
 * The design file's type/plan/status filter dropdowns (Directory screen,
 * `designs/Nia Console (superadmin).html`) are intentionally not wired up
 * by this route yet, for the same reason: filtering by a plan tier or
 * status that is identical for every row today would be a non-functional
 * control, not a real filter. `search` (by org name) is the only filter
 * that is genuinely meaningful right now and is implemented below.
 *
 * `limit`/`offset` page through the result (sensible default limit of 50,
 * hard max of 200, both enforced by the schema below). The response always
 * carries `total` (a separate `count(*)` over the same `where`, run inside
 * the same `withServiceRole` block) and `hasMore` — the Directory screen
 * must never silently truncate a result set with no indication more exists;
 * see console-plan.md's decision 10 for the client-side-search
 * consequence this still has (the loaded-so-far list, not the full
 * `total`, is what gets searched client-side).
 */
const listOrgsQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consoleRouter.get(
  "/orgs",
  validate({ query: listOrgsQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const {
      search = "",
      limit = 50,
      offset = 0,
    } = req.query as unknown as { search?: string; limit?: number; offset?: number };

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const countResult = await db.query<{ count: string }>(
        `select count(*) as count
         from public.organizations o
         where ($1 = '' or o.name ilike '%' || $1 || '%')`,
        [search],
      );

      const result = await db.query<{
        id: string;
        name: string;
        slug: string;
        created_at: string;
        suspended_at: string | null;
        member_count: string;
        runs_30d: string;
      }>(
        `select
           o.id,
           o.name,
           o.slug,
           o.created_at,
           o.suspended_at,
           count(distinct om.user_id) as member_count,
           count(distinct wr.id) filter (where wr.started_at > now() - interval '30 days') as runs_30d
         from public.organizations o
         left join public.organization_members om on om.org_id = o.id
         left join public.workflow_runs wr on wr.org_id = o.id
         where ($1 = '' or o.name ilike '%' || $1 || '%')
         group by o.id
         order by o.created_at desc
         limit $2
         offset $3`,
        [search, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.list",
        null,
        null,
        JSON.stringify({ search: search || null, limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      orgs: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        planTier: "Pro",
        status: row.suspended_at === null ? "Active" : "Suspended",
        memberCount: Number(row.member_count),
        runs30d: Number(row.runs_30d),
        createdAt: row.created_at,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

/**
 * Build order steps 6-7 / Slice 2 (console-plan.md §3, §5, §5a decision 8).
 * Org detail: profile, plan/limits, usage, members (read-only) — no
 * mutation in this slice ("View as"/impersonation, suspend/unsuspend,
 * delete, and password reset are all out of v1 or later build-order steps
 * per §1's screen-mapping table).
 *
 * `plan_tier`/`workflow_limit` come from `org_plan` (step 7), left-joined
 * rather than inner-joined: `org_plan` is only ever populated by this
 * migration's one-time backfill (every org that existed when 0042 ran) —
 * nothing yet inserts a row for an org created *after* that migration, and
 * fixing that is out of this slice's scope (no org-creation-path change
 * was asked for). `case when op.org_id is null` (not `coalesce`) is
 * deliberate: it distinguishes "no org_plan row at all" (defaults to
 * today's getPlanUsage() constant, Pro/25) from "a row exists with
 * workflow_limit explicitly null" (unlimited, per org_plan's own column
 * comment) — a plain coalesce would collapse those two different states
 * into the same default.
 *
 * `used` (workflow count) is computed on read, scoped to this one org, via
 * the same `workflows` table apps/web/src/lib/billing/plan.ts's
 * getPlanUsage() call sites count via getDashboardStats() — not a stored
 * column, per console-plan.md §2 ("usage is computed on read"), so it can
 * never drift from the real row count.
 *
 * `members` reads `organization_members` joined to `public.user` for
 * name/email — same cross-org service-role read exception documented on
 * GET /orgs above, scoped here to exactly one org's membership rather than
 * every org.
 *
 * `status`/`runs30d` are included for the same reason GET /orgs already
 * returns them: the design's org header meta line
 * (`designs/Nia Console (superadmin).html`'s `orgMeta`) is
 * "{plan} · {N} people · {M} runs in 30 days · {status}" — `status` is now
 * real (build step 9/Slice 3b), and `suspendedAt`/`suspendedReason`/
 * `suspendedBy` are also returned (null when active) so the Org Detail
 * screen's suspend/unsuspend UI has the current reason to show without a
 * second request. `runs30d` is a real `workflow_runs` count scoped to this
 * org, computed the identical way GET /orgs already computes it per-row.
 *
 * One staff_audit_log row per request (action 'org.read', org_id set) —
 * this route touches exactly one org, so it follows §3's general audit
 * rule directly, not the list endpoint's "one row per page" exception
 * (decision 4/10).
 */
const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });

consoleRouter.get(
  "/orgs/:orgId",
  validate({ params: orgIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };

    const result = await withServiceRole(dbPool, async (db) => {
      const orgResult = await db.query<{
        id: string;
        name: string;
        slug: string;
        created_at: string;
        plan_tier: string;
        workflow_limit: number | null;
        suspended_at: string | null;
        suspended_reason: string | null;
        suspended_by: string | null;
        suspended_by_name: string | null;
      }>(
        `select
           o.id,
           o.name,
           o.slug,
           o.created_at,
           case when op.org_id is null then 'Pro' else op.plan_tier end as plan_tier,
           case when op.org_id is null then 25 else op.workflow_limit end as workflow_limit,
           o.suspended_at,
           o.suspended_reason,
           o.suspended_by,
           su.name as suspended_by_name
         from public.organizations o
         left join public.org_plan op on op.org_id = o.id
         left join public."user" su on su.id = o.suspended_by
         where o.id = $1`,
        [orgId],
      );

      const org = orgResult.rows[0];
      if (!org) return null;

      const [usageResult, runsResult, membersResult] = await Promise.all([
        db.query<{ count: number }>(`select count(*)::int as count from public.workflows where org_id = $1`, [
          orgId,
        ]),
        db.query<{ count: number }>(
          `select count(*)::int as count from public.workflow_runs
           where org_id = $1 and started_at > now() - interval '30 days'`,
          [orgId],
        ),
        db.query<{
          user_id: string;
          name: string;
          email: string;
          role: string;
          created_at: string;
        }>(
          `select om.user_id, u.name, u.email, om.role, om.created_at
           from public.organization_members om
           join public."user" u on u.id = om.user_id
           where om.org_id = $1
           order by om.created_at asc`,
          [orgId],
        ),
      ]);

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.read",
        null,
        orgId,
        JSON.stringify({}),
      ]);

      return {
        org,
        usedCount: usageResult.rows[0]?.count ?? 0,
        runs30d: runsResult.rows[0]?.count ?? 0,
        members: membersResult.rows,
      };
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({
      id: result.org.id,
      name: result.org.name,
      slug: result.org.slug,
      createdAt: result.org.created_at,
      planTier: result.org.plan_tier,
      status: result.org.suspended_at === null ? "Active" : "Suspended",
      suspendedAt: result.org.suspended_at,
      suspendedReason: result.org.suspended_reason,
      suspendedBy: result.org.suspended_by === null ? null : { userId: result.org.suspended_by, name: result.org.suspended_by_name },
      workflowLimit: result.org.workflow_limit,
      workflowsUsed: result.usedCount,
      runs30d: result.runs30d,
      members: result.members.map((m) => ({
        userId: m.user_id,
        name: m.name,
        email: m.email,
        role: m.role,
        joinedAt: m.created_at,
      })),
    });
  }),
);

/**
 * Build order step 8 / Slice 3a (console-plan.md §3, §5, decision 6).
 * `PATCH /console/orgs/:orgId/plan` — the only mutation slice 3a adds. Body
 * uses this API's usual camelCase convention (planTier/workflowLimit,
 * matching GET /orgs/:orgId's own response shape and every other route's
 * body schema in this file/connections.ts/workflows.ts) rather than the
 * plan doc's prose `{ plan_tier, workflow_limit }` — that text is
 * describing org_plan's *column* shape (decision 6's actual subject), not
 * a literal JSON casing requirement; no other route in this codebase
 * accepts a snake_case body.
 *
 * `workflowLimit: null` means unlimited (org_plan's own column comment);
 * a positive integer sets a real cap. Upserts org_plan directly via
 * withServiceRole (org_plan has no authenticated write grant at all —
 * 0042/0044 — write-only via service_role, same as every other write in
 * this router) rather than a dedicated RPC, matching GET /orgs/:orgId's
 * own plain-query style.
 *
 * Writes exactly two audit rows per §3's general rule: one
 * `staff_audit_log` row (`private.log_staff_action`, same as every other
 * route here) and one row in the org's own `audit_log` via the new
 * `private.log_org_audit` helper (0045_workflow_plan_enforcement.sql —
 * see that migration's header comment for why the plan doc's literal
 * `private.log_audit()` call isn't usable from a withServiceRole route).
 */
const patchOrgPlanBodySchema = z.object({
  planTier: z.string().trim().min(1).max(40),
  workflowLimit: z.number().int().positive().nullable(),
});

consoleRouter.patch(
  "/orgs/:orgId/plan",
  validate({ params: orgIdParamsSchema, body: patchOrgPlanBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };
    const { planTier, workflowLimit } = req.body as unknown as { planTier: string; workflowLimit: number | null };

    const updated = await withServiceRole(dbPool, async (db) => {
      const orgResult = await db.query<{ id: string }>(`select id from public.organizations where id = $1`, [orgId]);
      if (!orgResult.rows[0]) return null;

      const planResult = await db.query<{ plan_tier: string; workflow_limit: number | null }>(
        `insert into public.org_plan (org_id, plan_tier, workflow_limit, updated_at, updated_by)
         values ($1, $2, $3, now(), $4)
         on conflict (org_id) do update set
           plan_tier = excluded.plan_tier,
           workflow_limit = excluded.workflow_limit,
           updated_at = now(),
           updated_by = excluded.updated_by
         returning plan_tier, workflow_limit`,
        [orgId, planTier, workflowLimit, authUser.id],
      );
      const plan = planResult.rows[0]!;

      const detail = JSON.stringify({ planTier: plan.plan_tier, workflowLimit: plan.workflow_limit });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.plan_update",
        null,
        orgId,
        detail,
      ]);
      await db.query("select private.log_org_audit($1, $2, $3, $4)", [orgId, authUser.id, "organization.plan_updated", detail]);

      return plan;
    });

    if (!updated) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({ planTier: updated.plan_tier, workflowLimit: updated.workflow_limit });
  }),
);

/**
 * Build order step 9 / Slice 3b (console-plan.md, decisions 1/2, additions
 * 3-6). `POST /console/orgs/:orgId/suspend` — `reason` is required (unlike
 * unsuspend's optional `note` below): a suspension always needs one, both
 * for the member-facing "Contact support" message (`attachActor`'s 403
 * detail) and for the audit trail.
 *
 * Enforcement itself lives entirely in 0046_org_suspension.sql's RLS
 * policies + `attachActor`'s 403 check + `runEtl.ts`'s cursor===null
 * check — this route only ever flips the three `organizations` columns
 * those all read. Same two-audit-row pattern as PATCH .../plan above.
 */
const suspendOrgBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

consoleRouter.post(
  "/orgs/:orgId/suspend",
  validate({ params: orgIdParamsSchema, body: suspendOrgBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };
    const { reason } = req.body as unknown as { reason: string };

    const updated = await withServiceRole(dbPool, async (db) => {
      const result = await db.query<{ suspended_at: string; suspended_reason: string }>(
        `update public.organizations
         set suspended_at = now(), suspended_by = $2, suspended_reason = $3
         where id = $1
         returning suspended_at, suspended_reason`,
        [orgId, authUser.id, reason],
      );
      const row = result.rows[0];
      if (!row) return null;

      const detail = JSON.stringify({ reason });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.suspend",
        null,
        orgId,
        detail,
      ]);
      await db.query("select private.log_org_audit($1, $2, $3, $4)", [orgId, authUser.id, "organization.suspended", detail]);

      return row;
    });

    if (!updated) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({ status: "Suspended", suspendedAt: updated.suspended_at, suspendedReason: updated.suspended_reason });
  }),
);

/**
 * `POST /console/orgs/:orgId/unsuspend` — addition 6: `note` is optional
 * (unlike suspend's required `reason`), written only to the two audit
 * rows (`private.log_staff_action`/`log_org_audit`'s `detail`), never
 * stored on `organizations` itself — there is no "why was this
 * unsuspended" column to keep in sync, only the audit trail.
 */
const unsuspendOrgBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
});

consoleRouter.post(
  "/orgs/:orgId/unsuspend",
  validate({ params: orgIdParamsSchema, body: unsuspendOrgBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };
    const { note } = req.body as unknown as { note?: string };

    const updated = await withServiceRole(dbPool, async (db) => {
      const result = await db.query<{ id: string }>(
        `update public.organizations
         set suspended_at = null, suspended_by = null, suspended_reason = null
         where id = $1
         returning id`,
        [orgId],
      );
      if (!result.rows[0]) return null;

      const detail = JSON.stringify({ note: note ?? null });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.unsuspend",
        null,
        orgId,
        detail,
      ]);
      await db.query("select private.log_org_audit($1, $2, $3, $4)", [orgId, authUser.id, "organization.unsuspended", detail]);

      return true;
    });

    if (!updated) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({ status: "Active" });
  }),
);

/**
 * Build order step 10 / Slice 3c (console-plan.md, decision 9). Run
 * history + error metadata for the org's Runs tab. Reads only
 * `workflow_runs.status/error/rows_processed/duration_ms/started_at/
 * finished_at` — never result rows/customer data, same boundary the
 * migration's own doc comment states. `error` (added by
 * 0047_workflow_runs_error.sql) is null for any run that hasn't failed,
 * or for a pre-migration failed run that finished before this column
 * existed.
 *
 * Most-recent-50, no pagination controls: unlike GET /orgs (which can
 * genuinely have hundreds of orgs), a single org's run history is bounded
 * enough that "load more" isn't worth the extra complexity this slice —
 * revisit if that assumption stops holding.
 */
consoleRouter.get(
  "/orgs/:orgId/runs",
  validate({ params: orgIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };

    const result = await withServiceRole(dbPool, async (db) => {
      const orgResult = await db.query<{ id: string }>(`select id from public.organizations where id = $1`, [orgId]);
      if (!orgResult.rows[0]) return null;

      const runsResult = await db.query<{
        id: string;
        workflow_id: string;
        status: string;
        error: { message: string } | null;
        rows_processed: number;
        duration_ms: number | null;
        started_at: string;
        finished_at: string | null;
      }>(
        `select id, workflow_id, status, error, rows_processed, duration_ms, started_at, finished_at
         from public.workflow_runs
         where org_id = $1
         order by started_at desc
         limit 50`,
        [orgId],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.runs_read",
        null,
        orgId,
        JSON.stringify({ count: runsResult.rowCount }),
      ]);

      return runsResult.rows;
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({
      runs: result.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        status: row.status,
        error: row.error,
        rowsProcessed: row.rows_processed,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
    });
  }),
);
