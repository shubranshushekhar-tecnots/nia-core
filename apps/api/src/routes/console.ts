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
import { sanitizeRunError } from "../lib/sanitizeRunError.js";
import { consoleUsageRouter } from "./consoleUsage.js";

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

// Console v2 Slice 4 — token usage + cost API (summary/timeseries/breakdown/
// top-consumers/export, model price CRUD). A separate router file (see its
// own header comment) mounted here, after the auth chain above, so every
// route in it inherits requireAuth -> attachDb -> requireStaff exactly like
// every route defined directly in this file.
consoleRouter.use(consoleUsageRouter);

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
 * `rowsLimit`/`copilotLimit`/`rowsUsed`/`copilotUsed` (Subscription Phase 3,
 * Slice 5, decision 8) read straight from `plans.rows_per_month`/
 * `plans.copilot_actions_per_month` — unlike workflow/project limits there
 * is no org_plan override column for these (confirmed: those two columns
 * exist only in 0049_plans_table.sql), so no case-when override logic is
 * needed. Usage is a grouped current-calendar-month sum over
 * `usage_events`, same query shape as
 * apps/api/src/services/dashboard.ts's getUsageThisMonth, just scoped to
 * this org instead of the caller's own workspace — display-only, no
 * override/edit affordance in this slice (matching decision 8's "staff see
 * an org's usage", not "staff set an org's usage limit").
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
        plan_id: string;
        plan_name: string;
        workflow_limit: number | null;
        workflow_limit_override_set: boolean;
        workflow_limit_override: number | null;
        project_limit: number | null;
        project_limit_override_set: boolean;
        project_limit_override: number | null;
        rows_limit: number | null;
        copilot_limit: number | null;
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
           op.plan_id,
           pl.name as plan_name,
           case when op.workflow_limit_set then op.workflow_limit else pl.workflow_limit end as workflow_limit,
           op.workflow_limit_set as workflow_limit_override_set,
           op.workflow_limit as workflow_limit_override,
           case when op.project_limit_set then op.project_limit else pl.project_limit end as project_limit,
           op.project_limit_set as project_limit_override_set,
           op.project_limit as project_limit_override,
           pl.rows_per_month as rows_limit,
           pl.copilot_actions_per_month as copilot_limit,
           o.suspended_at,
           o.suspended_reason,
           o.suspended_by,
           su.name as suspended_by_name
         from public.organizations o
         join public.org_plan op on op.org_id = o.id
         join public.plans pl on pl.id = op.plan_id
         left join public."user" su on su.id = o.suspended_by
         where o.id = $1`,
        [orgId],
      );

      const org = orgResult.rows[0];
      if (!org) return null;

      const [workflowUsageResult, projectUsageResult, runsResult, membersResult, usageResult] = await Promise.all([
        db.query<{ count: number }>(`select count(*)::int as count from public.workflows where org_id = $1`, [
          orgId,
        ]),
        db.query<{ count: number }>(`select count(*)::int as count from public.projects where org_id = $1`, [
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
        // Subscription Phase 3, Slice 5 (decision 8) — same grouped-sum shape
        // as apps/api/src/services/dashboard.ts's getUsageThisMonth, scoped
        // to this one org rather than the caller's own workspace.
        db.query<{ kind: string; used: string | null }>(
          `select kind, sum(quantity)::bigint as used
           from public.usage_events
           where org_id = $1 and occurred_at >= date_trunc('month', now())
           group by kind`,
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
        workflowsUsed: workflowUsageResult.rows[0]?.count ?? 0,
        projectsUsed: projectUsageResult.rows[0]?.count ?? 0,
        runs30d: runsResult.rows[0]?.count ?? 0,
        members: membersResult.rows,
        rowsUsed: Number(usageResult.rows.find((r) => r.kind === "rows_moved")?.used ?? 0),
        copilotUsed: Number(usageResult.rows.find((r) => r.kind === "copilot_action")?.used ?? 0),
      };
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({
      id: result.org.id,
      name: result.org.name,
      slug: result.org.slug,
      createdAt: result.org.created_at,
      planId: result.org.plan_id,
      planTier: result.org.plan_name,
      status: result.org.suspended_at === null ? "Active" : "Suspended",
      suspendedAt: result.org.suspended_at,
      suspendedReason: result.org.suspended_reason,
      suspendedBy: result.org.suspended_by === null ? null : { userId: result.org.suspended_by, name: result.org.suspended_by_name },
      workflowLimit: result.org.workflow_limit,
      workflowLimitOverrideSet: result.org.workflow_limit_override_set,
      workflowLimitOverride: result.org.workflow_limit_override,
      workflowsUsed: result.workflowsUsed,
      projectLimit: result.org.project_limit,
      projectLimitOverrideSet: result.org.project_limit_override_set,
      projectLimitOverride: result.org.project_limit_override,
      projectsUsed: result.projectsUsed,
      rowsLimit: result.org.rows_limit,
      rowsUsed: result.rowsUsed,
      copilotLimit: result.org.copilot_limit,
      copilotUsed: result.copilotUsed,
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
 * Build order step 8 / Slice 3a (console-plan.md §3, §5, decision 6),
 * extended for subscription-model Phase 1. `PATCH /console/orgs/:orgId/plan`
 * — the only mutation slice 3a adds. Body now carries `planId` (org_plan's
 * new FK into the plans catalog) plus the four override fields, replacing
 * the old free-text `planTier`/`workflowLimit` shape now that org_plan is
 * guaranteed exactly one row per org (0050's backfill) resolved through the
 * plans join rather than storing its own tier name/limit directly.
 * `*LimitOverrideSet: false` means "inherit the plan's default" (the edit
 * form's "Clear override"); `true` with a null value means an explicit
 * unlimited override, `true` with a positive integer means an explicit cap
 * — same tri-state semantics as the enforcement triggers read.
 *
 * Upserts org_plan directly via withServiceRole (org_plan has no
 * authenticated write grant at all — 0042/0044 — write-only via
 * service_role, same as every other write in this router) rather than a
 * dedicated RPC, matching GET /orgs/:orgId's own plain-query style.
 *
 * Writes exactly two audit rows per §3's general rule: one
 * `staff_audit_log` row (`private.log_staff_action`, same as every other
 * route here) and one row in the org's own `audit_log` via the
 * `private.log_org_audit` helper (0045_workflow_plan_enforcement.sql —
 * see that migration's header comment for why the plan doc's literal
 * `private.log_audit()` call isn't usable from a withServiceRole route).
 */
const patchOrgPlanBodySchema = z.object({
  planId: z.string().trim().min(1).max(40),
  workflowLimitOverrideSet: z.boolean(),
  workflowLimitOverride: z.number().int().positive().nullable(),
  projectLimitOverrideSet: z.boolean(),
  projectLimitOverride: z.number().int().positive().nullable(),
});

consoleRouter.patch(
  "/orgs/:orgId/plan",
  validate({ params: orgIdParamsSchema, body: patchOrgPlanBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };
    const {
      planId,
      workflowLimitOverrideSet,
      workflowLimitOverride,
      projectLimitOverrideSet,
      projectLimitOverride,
    } = req.body as unknown as {
      planId: string;
      workflowLimitOverrideSet: boolean;
      workflowLimitOverride: number | null;
      projectLimitOverrideSet: boolean;
      projectLimitOverride: number | null;
    };

    const updated = await withServiceRole(dbPool, async (db) => {
      const orgResult = await db.query<{ id: string }>(`select id from public.organizations where id = $1`, [orgId]);
      if (!orgResult.rows[0]) return null;

      const planExistsResult = await db.query<{ id: string }>(`select id from public.plans where id = $1`, [planId]);
      if (!planExistsResult.rows[0]) throw new AppError(400, "INVALID_PLAN", "Unknown plan id.");

      const planResult = await db.query<{
        plan_id: string;
        workflow_limit_set: boolean;
        workflow_limit: number | null;
        project_limit_set: boolean;
        project_limit: number | null;
      }>(
        `insert into public.org_plan (
           org_id, plan_id, workflow_limit_set, workflow_limit, project_limit_set, project_limit, updated_at, updated_by
         )
         values ($1, $2, $3, $4, $5, $6, now(), $7)
         on conflict (org_id) do update set
           plan_id = excluded.plan_id,
           workflow_limit_set = excluded.workflow_limit_set,
           workflow_limit = excluded.workflow_limit,
           project_limit_set = excluded.project_limit_set,
           project_limit = excluded.project_limit,
           updated_at = now(),
           updated_by = excluded.updated_by
         returning plan_id, workflow_limit_set, workflow_limit, project_limit_set, project_limit`,
        [orgId, planId, workflowLimitOverrideSet, workflowLimitOverride, projectLimitOverrideSet, projectLimitOverride, authUser.id],
      );
      const plan = planResult.rows[0]!;

      const detail = JSON.stringify({
        planId: plan.plan_id,
        workflowLimitOverrideSet: plan.workflow_limit_set,
        workflowLimitOverride: plan.workflow_limit,
        projectLimitOverrideSet: plan.project_limit_set,
        projectLimitOverride: plan.project_limit,
      });

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

    res.json({
      planId: updated.plan_id,
      workflowLimitOverrideSet: updated.workflow_limit_set,
      workflowLimitOverride: updated.workflow_limit,
      projectLimitOverrideSet: updated.project_limit_set,
      projectLimitOverride: updated.project_limit,
    });
  }),
);

/**
 * Subscription model Phase 1. `GET /console/plans` — the plan catalog
 * (0049_plans_table.sql), for the Org Detail edit-plan form's dropdown.
 * Read-only, no staff_audit_log row (matches GET /orgs's own list-endpoint
 * exception in decision 4/10 — this is reference data, not a per-org
 * lookup). Ordered free/pro/team/enterprise first (upgrade path order),
 * legacy last (not a plan staff should assign going forward).
 */
consoleRouter.get(
  "/plans",
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const result = await withServiceRole(dbPool, async (db) =>
      db.query<{ id: string; name: string; project_limit: number | null; workflow_limit: number | null }>(
        `select id, name, project_limit, workflow_limit
         from public.plans
         order by case id
           when 'free' then 1
           when 'pro' then 2
           when 'team' then 3
           when 'enterprise' then 4
           when 'legacy' then 5
           else 6
         end`,
      ),
    );

    res.json({
      plans: result.rows.map((p) => ({
        id: p.id,
        name: p.name,
        projectLimit: p.project_limit,
        workflowLimit: p.workflow_limit,
      })),
    });
  }),
);

/**
 * Subscription Phase 5, Slice 5 (docs/plans/subscription-model.md, decision
 * 2). Staff-initiated member removal — reason required for both the audit
 * trail and the org-facing announcement. Last-owner / billing-owner
 * protection is NOT reimplemented here: it's already enforced at the DB
 * layer by private.protect_last_super_admin (0004_owner_rename.sql,
 * extended by 0061_billing_owner.sql) on organization_members' own DELETE
 * trigger, which fires regardless of who performs the delete (service_role
 * included — RLS bypass never bypasses triggers). This route just attempts
 * the delete and, on failure, surfaces the trigger's own raised exception
 * message directly as the customer-facing error — same "the trigger's own
 * message IS the customer-facing copy" convention
 * apps/web/src/lib/members/actions.ts's friendlyMemberError already
 * follows for the self-service path.
 *
 * Also removes the user's project_members rows for every project in this
 * org (0054_project_members.sql) — membership in the org's own projects
 * has no independent meaning once they're not an org member at all.
 *
 * Writes both audit rows (§3's rule) AND inserts a targeted announcement
 * (audience='org', audience_roles=['owner','admin'], severity='info') so
 * the org's owners/admins learn about the removal even though staff acted
 * without going through them — decision 2's exact message template.
 */
const removeMemberBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const orgMemberParamsSchema = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

consoleRouter.post(
  "/orgs/:orgId/members/:userId/remove",
  validate({ params: orgMemberParamsSchema, body: removeMemberBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId, userId } = req.params as unknown as { orgId: string; userId: string };
    const { reason } = req.body as unknown as { reason: string };

    await withServiceRole(dbPool, async (db) => {
      const targetResult = await db.query<{ name: string | null; email: string }>(
        `select name, email from public."user" where id = $1`,
        [userId],
      );
      const target = targetResult.rows[0];
      if (!target) throw new AppError(404, "NOT_FOUND", "User not found.");

      const orgResult = await db.query<{ name: string }>(`select name from public.organizations where id = $1`, [orgId]);
      const org = orgResult.rows[0];
      if (!org) throw new AppError(404, "NOT_FOUND", "Organization not found.");

      let deleteResult;
      try {
        deleteResult = await db.query(`delete from public.organization_members where org_id = $1 and user_id = $2`, [
          orgId,
          userId,
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't remove that member.";
        throw new AppError(400, "CANNOT_REMOVE_MEMBER", message);
      }
      if (deleteResult.rowCount === 0) {
        throw new AppError(404, "NOT_FOUND", "That user is not a member of this organization.");
      }

      await db.query(
        `delete from public.project_members
         where user_id = $1 and project_id in (select id from public.projects where org_id = $2)`,
        [userId, orgId],
      );

      const displayName = target.name ?? target.email;
      const detail = JSON.stringify({ reason, targetUserId: userId, targetName: displayName });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.member_remove",
        userId,
        orgId,
        detail,
      ]);
      await db.query("select private.log_org_audit($1, $2, $3, $4)", [
        orgId,
        authUser.id,
        "organization.member_removed",
        detail,
      ]);

      const noticeBody = `A Nia staff member removed ${displayName} from ${org.name}. Reason: ${reason}`;
      await db.query(
        `insert into public.announcements (title, body, severity, audience, audience_org_id, audience_roles, created_by)
         values ($1, $2, 'info', 'org', $3, $4, $5)`,
        ["Member removed", noticeBody, orgId, ["owner", "admin"], authUser.id],
      );
    });

    res.json({ status: "removed" });
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
 *
 * Small fix (2026-09-29): `error` is run through sanitizeRunError()
 * (lib/sanitizeRunError.ts) before it leaves this route — a raw
 * destination-write failure's error text can embed the customer's own row
 * value (Postgres DETAIL's "Key (col)=(val) already exists"), which staff
 * don't need and shouldn't see. Response shape changes from `{ message }`
 * to `{ code, message }`. The customer-facing explain_last_error copilot
 * tool (copilot/tools/explainLastError.ts) reads the same column directly
 * and deliberately keeps the raw message — it's the customer's own data.
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
        error: sanitizeRunError(row.error),
        rowsProcessed: row.rows_processed,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
    });
  }),
);

/**
 * Build order step 11 / Slice 3d (console-plan.md §3, §5a). Connector
 * health for the org's Connectors tab: type, display name, last-test
 * result, created date. Reads only `connections.connector_id/display_name/
 * last_test_status/last_test_latency_ms/last_test_at/created_at` — an
 * explicit column list, never `select *`, so a future column added to
 * `connections` (e.g. `config`, which can carry a non-secret host/port, or
 * `vault_secret_ref`, which never should) doesn't silently start leaking
 * here. Org-scoped connections only (`connections.org_id = $1`) — personal
 * (owner-scoped) connections have `org_id is null` and are out of scope
 * for an org-detail screen by definition, same reasoning `GET .../runs`
 * already applies to `workflow_runs.org_id`.
 */
consoleRouter.get(
  "/orgs/:orgId/connectors",
  validate({ params: orgIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { orgId } = req.params as unknown as { orgId: string };

    const result = await withServiceRole(dbPool, async (db) => {
      const orgResult = await db.query<{ id: string }>(`select id from public.organizations where id = $1`, [orgId]);
      if (!orgResult.rows[0]) return null;

      const connectorsResult = await db.query<{
        id: string;
        connector_id: string;
        display_name: string;
        last_test_status: "ok" | "error" | null;
        last_test_latency_ms: number | null;
        last_test_at: string | null;
        created_at: string;
      }>(
        `select id, connector_id, display_name, last_test_status, last_test_latency_ms, last_test_at, created_at
         from public.connections
         where org_id = $1
         order by created_at desc`,
        [orgId],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "org.connectors_read",
        null,
        orgId,
        JSON.stringify({ count: connectorsResult.rowCount }),
      ]);

      return connectorsResult.rows;
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "Organization not found.");

    res.json({
      connectors: result.map((row) => ({
        id: row.id,
        connectorId: row.connector_id,
        displayName: row.display_name,
        lastTestStatus: row.last_test_status,
        lastTestLatencyMs: row.last_test_latency_ms,
        lastTestAt: row.last_test_at,
        createdAt: row.created_at,
      })),
    });
  }),
);

/**
 * Build order step 12 / Slice 3e (console-plan.md §3, §5a). List/search
 * users for the Users screen. Reads directly from `public."user"` — not
 * joined through `organization_members` — so a personal/owner-scoped
 * (individual, no-org) user is a first-class search result too, not just
 * org members (console-plan.md's own note on `GET /console/orgs`'s
 * type-filter scope: "confirming GET /console/users must include them, not
 * just org members").
 *
 * Explicit column allowlist, same discipline as every other route in this
 * file: `public."user"` has no password/token/2FA columns today (those
 * live on `public.account`/`public.session`, never touched here), but the
 * SELECT still lists exactly the columns needed rather than `select *`, so
 * a future column added to `user` doesn't silently start leaking here.
 *
 * Same `limit`/`offset`/`total`/`hasMore` paging shape as `GET /console/orgs`
 * (decision 10's "never silently truncate" rule applies identically here).
 * `orgCount` (a `count(distinct om.org_id)`) is included as useful list
 * context, same role `memberCount`/`runs30d` play on the org list row.
 */
const listUsersQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

consoleRouter.get(
  "/users",
  validate({ query: listUsersQuerySchema }),
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
         from public."user" u
         where ($1 = '' or u.name ilike '%' || $1 || '%' or u.email ilike '%' || $1 || '%')`,
        [search],
      );

      const result = await db.query<{
        id: string;
        name: string;
        email: string;
        created_at: string;
        org_count: string;
      }>(
        `select
           u.id,
           u.name,
           u.email,
           u."createdAt" as created_at,
           count(distinct om.org_id) as org_count
         from public."user" u
         left join public.organization_members om on om.user_id = u.id
         where ($1 = '' or u.name ilike '%' || $1 || '%' or u.email ilike '%' || $1 || '%')
         group by u.id
         order by u."createdAt" desc
         limit $2
         offset $3`,
        [search, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "user.list",
        null,
        null,
        JSON.stringify({ search: search || null, limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      users: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        orgCount: Number(row.org_count),
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
 * Build order step 12 / Slice 3e (console-plan.md §3, §5a). User detail:
 * profile, org memberships (with role), and session metadata — count and
 * most-recent `createdAt` only, **never** `session.token` (the live
 * session credential) and never anything from `public.account` (which
 * stores the password hash in its `password` column, plus OAuth access/
 * refresh tokens) — this route's three queries touch `user`/
 * `organization_members`+`organizations`/`session` only, and `session`'s
 * own SELECT is an explicit column list that excludes `token` by
 * construction, the same defense-in-depth allowlist discipline as
 * `GET /orgs/:orgId/connectors`'s exclusion of `vault_secret_ref`/`config`.
 * No 2FA columns exist yet to exclude (console-plan.md decision 7 — 2FA
 * isn't implemented for v1).
 */
const userIdParamsSchema = z.object({ userId: z.string().uuid() });

consoleRouter.get(
  "/users/:userId",
  validate({ params: userIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { userId } = req.params as unknown as { userId: string };

    const result = await withServiceRole(dbPool, async (db) => {
      const userResult = await db.query<{
        id: string;
        name: string;
        email: string;
        email_verified: boolean;
        created_at: string;
      }>(
        `select id, name, email, "emailVerified" as email_verified, "createdAt" as created_at
         from public."user"
         where id = $1`,
        [userId],
      );

      const user = userResult.rows[0];
      if (!user) return null;

      const [membershipsResult, sessionResult] = await Promise.all([
        db.query<{
          org_id: string;
          org_name: string;
          role: string;
          created_at: string;
        }>(
          `select om.org_id, o.name as org_name, om.role, om.created_at
           from public.organization_members om
           join public.organizations o on o.id = om.org_id
           where om.user_id = $1
           order by om.created_at asc`,
          [userId],
        ),
        db.query<{ count: string; last_sign_in_at: string | null }>(
          `select count(*) as count, max("createdAt") as last_sign_in_at
           from public."session"
           where "userId" = $1`,
          [userId],
        ),
      ]);

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "user.read",
        userId,
        null,
        JSON.stringify({}),
      ]);

      return {
        user,
        memberships: membershipsResult.rows,
        sessionCount: Number(sessionResult.rows[0]?.count ?? 0),
        lastSignInAt: sessionResult.rows[0]?.last_sign_in_at ?? null,
      };
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "User not found.");

    res.json({
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      emailVerified: result.user.email_verified,
      createdAt: result.user.created_at,
      memberships: result.memberships.map((m) => ({
        orgId: m.org_id,
        orgName: m.org_name,
        role: m.role,
        joinedAt: m.created_at,
      })),
      sessionCount: result.sessionCount,
      lastSignInAt: result.lastSignInAt,
    });
  }),
);

/**
 * Build order step 13 / Slice 3f (console-plan.md §3, §5a, decisions 3/4).
 * `POST /console/users/:userId/revoke-sessions` — "Sign out everywhere".
 * `reason` is required, same posture as org suspend's `reason` above.
 *
 * Raw `delete from public.session` via service role (decision 3, finalized
 * 2026-09-28) — deliberately NOT better-auth's `admin` plugin, which bundles
 * `revokeUserSessions` together with impersonate-user/ban-user/setRole as
 * live HTTP endpoints the instant it's enabled, conflicting with this
 * Console's "never: impersonation" principle. Deleting the session rows is
 * sufficient on its own: better-auth's `getSession` looks up the session
 * token against this same table on every request, so a deleted row fails
 * that lookup immediately, on the user's very next request — no separate
 * "revoke" flag or token-blocklist needed. Caveat for the future (console-
 * plan.md line ~157): if `cookieCache`/`secondaryStorage` is ever turned on
 * for this app's better-auth config, that in-memory/secondary cache would
 * also need busting here, since a cached session could still validate after
 * the row is gone. Not relevant today — neither is enabled.
 *
 * Audited per decision 4: one `staff_audit_log` row (action
 * 'user.revoke_sessions', target_user_id set, org_id null — this action
 * targets a user, not a single org, same shape as `user.read` above) plus
 * one `audit_log` row in *every* org the target user belongs to (queried via
 * `organization_members`, looped — `private.log_org_audit` requires a
 * non-null org_id per call, it has no "batch"/null-org mode). A user with
 * zero memberships (individual workspace) naturally produces zero
 * `log_org_audit` calls, matching decision 4's explicit fallback.
 *
 * No special-case for a staff member revoking their own sessions: the
 * current request already passed authentication before this handler runs,
 * so it completes normally either way — deleting your own session rows only
 * affects your *next* request, same as anyone else's. The "warn they'll be
 * signed out" requirement is a frontend-only confirmation-copy concern
 * (comparing the target userId to the signed-in staff user's own id), not a
 * backend branch.
 */
const revokeSessionsBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

consoleRouter.post(
  "/users/:userId/revoke-sessions",
  validate({ params: userIdParamsSchema, body: revokeSessionsBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { userId } = req.params as unknown as { userId: string };
    const { reason } = req.body as unknown as { reason: string };

    const result = await withServiceRole(dbPool, async (db) => {
      const userResult = await db.query<{ id: string }>(`select id from public."user" where id = $1`, [userId]);
      if (!userResult.rows[0]) return null;

      const deleteResult = await db.query(`delete from public."session" where "userId" = $1`, [userId]);
      const revokedCount = deleteResult.rowCount ?? 0;

      const membershipsResult = await db.query<{ org_id: string }>(
        `select org_id from public.organization_members where user_id = $1`,
        [userId],
      );

      const detail = JSON.stringify({ reason, revokedCount });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "user.revoke_sessions",
        userId,
        null,
        detail,
      ]);

      for (const { org_id } of membershipsResult.rows) {
        await db.query("select private.log_org_audit($1, $2, $3, $4)", [
          org_id,
          authUser.id,
          "organization.member_sessions_revoked",
          detail,
        ]);
      }

      return { revokedCount };
    });

    if (!result) throw new AppError(404, "NOT_FOUND", "User not found.");

    res.json({ revokedSessionCount: result.revokedCount });
  }),
);

/**
 * Subscription Phase 5, Slice 2 (decision 1) — in-app announcements.
 * Staff-authored, staff-write-only (0067_announcements.sql grants SELECT
 * only to `authenticated`), so every mutation here goes through
 * withServiceRole same as the rest of this router. `serializeAnnouncement`
 * maps a DB row (snake_case, optionally carrying a computed `status` and
 * `created_by_name`) to the camelCase shape every route below returns.
 */
function serializeAnnouncement(row: {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  audience_org_id: string | null;
  audience_project_id: string | null;
  audience_roles: string[] | null;
  starts_at: string;
  ends_at: string | null;
  archived_at: string | null;
  created_by: string;
  created_by_name?: string | null;
  created_at: string;
  status?: string;
}) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    audience: row.audience,
    audienceOrgId: row.audience_org_id,
    audienceProjectId: row.audience_project_id,
    audienceRoles: row.audience_roles,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    status: row.status ?? null,
  };
}

/**
 * Resolves which org (if any) an announcement's audit trail should also be
 * written against, per the Console principle "customer-affecting actions
 * are also audited in the org's audit_log": an 'org'-audience announcement
 * targets that org directly; a 'project'-audience one targets whichever
 * org owns that project; 'all' targets no single org, so only
 * staff_audit_log gets a row.
 */
async function resolveAnnouncementAuditOrgId(
  db: Parameters<Parameters<typeof withServiceRole>[1]>[0],
  row: { audience: string; audience_org_id: string | null; audience_project_id: string | null },
): Promise<string | null> {
  if (row.audience === "org") return row.audience_org_id;
  if (row.audience === "project" && row.audience_project_id) {
    const result = await db.query<{ org_id: string | null }>(
      `select org_id from public.projects where id = $1`,
      [row.audience_project_id],
    );
    return result.rows[0]?.org_id ?? null;
  }
  return null;
}

const announcementSeveritySchema = z.enum(["info", "warning", "critical"]);
const announcementAudienceSchema = z.enum(["all", "org", "project"]);
const orgRoleSchema = z.enum(["member", "admin", "owner", "viewer"]);

/**
 * Mirrors 0067_announcements.sql's tri-state audience CHECK constraint
 * exactly, so a malformed request gets a friendly 400 here rather than a
 * raw Postgres constraint-violation error.
 */
const createAnnouncementBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    severity: announcementSeveritySchema.default("info"),
    audience: announcementAudienceSchema,
    audienceOrgId: z.string().uuid().optional(),
    audienceProjectId: z.string().uuid().optional(),
    audienceRoles: z.array(orgRoleSchema).min(1).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.audience === "all") {
      if (val.audienceOrgId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceOrgId"], message: "audienceOrgId must not be set for audience 'all'" });
      if (val.audienceProjectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceProjectId"], message: "audienceProjectId must not be set for audience 'all'" });
      if (val.audienceRoles) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceRoles"], message: "audienceRoles must not be set for audience 'all'" });
    } else if (val.audience === "org") {
      if (!val.audienceOrgId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceOrgId"], message: "audienceOrgId is required for audience 'org'" });
      if (val.audienceProjectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceProjectId"], message: "audienceProjectId must not be set for audience 'org'" });
    } else if (val.audience === "project") {
      if (!val.audienceProjectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceProjectId"], message: "audienceProjectId is required for audience 'project'" });
      if (val.audienceOrgId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceOrgId"], message: "audienceOrgId must not be set for audience 'project'" });
      if (val.audienceRoles) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audienceRoles"], message: "audienceRoles is not supported for audience 'project'" });
    }
    if (val.startsAt && val.endsAt && new Date(val.endsAt) <= new Date(val.startsAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
  });

consoleRouter.post(
  "/announcements",
  validate({ body: createAnnouncementBodySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const body = req.body as unknown as {
      title: string;
      body: string;
      severity: "info" | "warning" | "critical";
      audience: "all" | "org" | "project";
      audienceOrgId?: string;
      audienceProjectId?: string;
      audienceRoles?: string[];
      startsAt?: string;
      endsAt?: string;
    };

    const created = await withServiceRole(dbPool, async (db) => {
      if (body.audience === "org") {
        const orgResult = await db.query<{ id: string }>(`select id from public.organizations where id = $1`, [body.audienceOrgId]);
        if (!orgResult.rows[0]) throw new AppError(404, "NOT_FOUND", "Organization not found.");
      }
      if (body.audience === "project") {
        const projectResult = await db.query<{ id: string }>(`select id from public.projects where id = $1`, [body.audienceProjectId]);
        if (!projectResult.rows[0]) throw new AppError(404, "NOT_FOUND", "Project not found.");
      }

      const result = await db.query<{
        id: string;
        title: string;
        body: string;
        severity: string;
        audience: string;
        audience_org_id: string | null;
        audience_project_id: string | null;
        audience_roles: string[] | null;
        starts_at: string;
        ends_at: string | null;
        archived_at: string | null;
        created_by: string;
        created_at: string;
      }>(
        `insert into public.announcements
           (title, body, severity, audience, audience_org_id, audience_project_id, audience_roles, starts_at, ends_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9, $10)
         returning id, title, body, severity, audience, audience_org_id, audience_project_id, audience_roles, starts_at, ends_at, archived_at, created_by, created_at`,
        [
          body.title,
          body.body,
          body.severity,
          body.audience,
          body.audienceOrgId ?? null,
          body.audienceProjectId ?? null,
          body.audienceRoles ?? null,
          body.startsAt ?? null,
          body.endsAt ?? null,
          authUser.id,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(500, "INTERNAL", "Failed to create announcement.");

      const auditOrgId = await resolveAnnouncementAuditOrgId(db, row);
      const detail = JSON.stringify({ id: row.id, title: row.title, severity: row.severity, audience: row.audience });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [authUser.id, "announcement.create", null, auditOrgId, detail]);
      if (auditOrgId) {
        await db.query("select private.log_org_audit($1, $2, $3, $4)", [auditOrgId, authUser.id, "announcement.created", detail]);
      }

      return row;
    });

    res.status(201).json(serializeAnnouncement(created));
  }),
);

const listAnnouncementsQuerySchema = z.object({
  status: z.enum(["active", "scheduled", "ended"]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Status is computed on read (never stored): 'ended' covers both an
 * explicitly ended (ends_at in the past) and an archived announcement, so
 * the three-tab UI (active/scheduled/ended) the spec asks for doesn't need
 * a fourth "archived" tab — archived rows simply surface there too, same
 * as any other ended one.
 */
consoleRouter.get(
  "/announcements",
  validate({ query: listAnnouncementsQuerySchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { status, limit = 50, offset = 0 } = req.query as unknown as { status?: string; limit?: number; offset?: number };

    const { rows, total } = await withServiceRole(dbPool, async (db) => {
      const statusExpr = `
        case
          when a.archived_at is not null then 'ended'
          when a.ends_at is not null and a.ends_at <= now() then 'ended'
          when a.starts_at > now() then 'scheduled'
          else 'active'
        end`;

      const countResult = await db.query<{ count: string }>(
        `select count(*) as count
         from public.announcements a
         where ($1::text is null or (${statusExpr}) = $1)`,
        [status ?? null],
      );

      const result = await db.query<{
        id: string;
        title: string;
        body: string;
        severity: string;
        audience: string;
        audience_org_id: string | null;
        audience_project_id: string | null;
        audience_roles: string[] | null;
        starts_at: string;
        ends_at: string | null;
        archived_at: string | null;
        created_by: string;
        created_by_name: string | null;
        created_at: string;
        status: string;
      }>(
        `select a.id, a.title, a.body, a.severity, a.audience, a.audience_org_id, a.audience_project_id,
                a.audience_roles, a.starts_at, a.ends_at, a.archived_at, a.created_by, u.name as created_by_name,
                a.created_at, (${statusExpr}) as status
         from public.announcements a
         left join public."user" u on u.id = a.created_by
         where ($1::text is null or (${statusExpr}) = $1)
         order by a.created_at desc
         limit $2
         offset $3`,
        [status ?? null, limit, offset],
      );

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [
        authUser.id,
        "announcement.list",
        null,
        null,
        JSON.stringify({ status: status ?? null, limit, offset, count: result.rowCount }),
      ]);

      return { rows: result.rows, total: Number(countResult.rows[0]?.count ?? 0) };
    });

    res.json({
      announcements: rows.map((row) => serializeAnnouncement(row)),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  }),
);

const announcementIdParamsSchema = z.object({ id: z.string().uuid() });

consoleRouter.post(
  "/announcements/:id/end",
  validate({ params: announcementIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { id } = req.params as unknown as { id: string };

    const updated = await withServiceRole(dbPool, async (db) => {
      const existingResult = await db.query<{
        id: string;
        audience: string;
        audience_org_id: string | null;
        audience_project_id: string | null;
        archived_at: string | null;
        ends_at: string | null;
      }>(`select id, audience, audience_org_id, audience_project_id, archived_at, ends_at from public.announcements where id = $1`, [id]);
      const existing = existingResult.rows[0];
      if (!existing) return { kind: "not_found" as const };
      if (existing.archived_at !== null) return { kind: "already_archived" as const };
      if (existing.ends_at !== null && new Date(existing.ends_at).getTime() <= Date.now()) return { kind: "already_ended" as const };

      const result = await db.query<{
        id: string;
        title: string;
        body: string;
        severity: string;
        audience: string;
        audience_org_id: string | null;
        audience_project_id: string | null;
        audience_roles: string[] | null;
        starts_at: string;
        ends_at: string | null;
        archived_at: string | null;
        created_by: string;
        created_at: string;
      }>(
        `update public.announcements set ends_at = now() where id = $1
         returning id, title, body, severity, audience, audience_org_id, audience_project_id, audience_roles, starts_at, ends_at, archived_at, created_by, created_at`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return { kind: "not_found" as const };

      const auditOrgId = await resolveAnnouncementAuditOrgId(db, row);
      const detail = JSON.stringify({ id: row.id, title: row.title });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [authUser.id, "announcement.end", null, auditOrgId, detail]);
      if (auditOrgId) {
        await db.query("select private.log_org_audit($1, $2, $3, $4)", [auditOrgId, authUser.id, "announcement.ended", detail]);
      }

      return { kind: "ok" as const, row };
    });

    if (updated.kind === "not_found") throw new AppError(404, "NOT_FOUND", "Announcement not found.");
    if (updated.kind === "already_archived") throw new AppError(400, "ALREADY_ARCHIVED", "This announcement is already archived.");
    if (updated.kind === "already_ended") throw new AppError(400, "ALREADY_ENDED", "This announcement has already ended.");

    res.json(serializeAnnouncement(updated.row));
  }),
);

consoleRouter.post(
  "/announcements/:id/archive",
  validate({ params: announcementIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const authUser = req.authUser;
    if (!authUser) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");

    const { id } = req.params as unknown as { id: string };

    const updated = await withServiceRole(dbPool, async (db) => {
      const existingResult = await db.query<{ id: string; archived_at: string | null }>(
        `select id, archived_at from public.announcements where id = $1`,
        [id],
      );
      const existing = existingResult.rows[0];
      if (!existing) return { kind: "not_found" as const };
      if (existing.archived_at !== null) return { kind: "already_archived" as const };

      const result = await db.query<{
        id: string;
        title: string;
        body: string;
        severity: string;
        audience: string;
        audience_org_id: string | null;
        audience_project_id: string | null;
        audience_roles: string[] | null;
        starts_at: string;
        ends_at: string | null;
        archived_at: string | null;
        created_by: string;
        created_at: string;
      }>(
        `update public.announcements set archived_at = now() where id = $1
         returning id, title, body, severity, audience, audience_org_id, audience_project_id, audience_roles, starts_at, ends_at, archived_at, created_by, created_at`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return { kind: "not_found" as const };

      const auditOrgId = await resolveAnnouncementAuditOrgId(db, row);
      const detail = JSON.stringify({ id: row.id, title: row.title });

      await db.query("select private.log_staff_action($1, $2, $3, $4, $5)", [authUser.id, "announcement.archive", null, auditOrgId, detail]);
      if (auditOrgId) {
        await db.query("select private.log_org_audit($1, $2, $3, $4)", [auditOrgId, authUser.id, "announcement.archived", detail]);
      }

      return { kind: "ok" as const, row };
    });

    if (updated.kind === "not_found") throw new AppError(404, "NOT_FOUND", "Announcement not found.");
    if (updated.kind === "already_archived") throw new AppError(400, "ALREADY_ARCHIVED", "This announcement is already archived.");

    res.json(serializeAnnouncement(updated.row));
  }),
);
