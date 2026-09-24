import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { RunStreamEvent } from "@nia/schemas";
import { requireCookieAuth } from "../middleware/cookieAuth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { requireCapability } from "../middleware/requireCapability.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { scopeFromActor } from "../lib/workspaceScope.js";
import { runSse, subscribeWithReplay } from "../lib/sse.js";
import { channelFor, replayLogKeyFor } from "../lib/runChannel.js";
import { startWorkflowRun, resolveRunOwnership } from "../services/runs.js";
import { env } from "../env.js";

/**
 * Cookie-authenticated sibling of routes/workflows.ts's other workflow
 * routes (mirrors routes/chat.ts's split from the Bearer-only routers) —
 * GET /:id/run/stream is consumed via a browser EventSource, which can
 * never attach a custom Authorization header, only same-origin cookies.
 * POST /:id/run doesn't strictly need cookie auth on its own, but is kept
 * on this router too so "start a run, then stream it" shares one
 * consistent auth story end to end instead of mixing Bearer and cookie
 * auth across the same feature. Reached same-origin through apps/web's
 * /api/backend/:path* rewrite, same as chat.
 *
 * Mounted at the same "/workflows" prefix as workflowsRouter, BEFORE it
 * (index.ts) — paths here are relative ("/:id/run", not "/workflows/:id/
 * run") and each route carries its own requireCookieAuth/attachActor
 * rather than a blanket router.use(), specifically so a request for one of
 * workflowsRouter's Bearer-authed paths (e.g. /:id/checks) correctly falls
 * through past this router untouched instead of being caught and 401'd by
 * a mismatched auth mode. See index.ts's mount-order comment.
 */
export const runsRouter: ExpressRouter = Router();

// requireCookieAuth/attachActor are applied per-route below, NOT as a
// blanket runsRouter.use() — this router is mounted at the "/workflows"
// prefix (index.ts), the same prefix workflowsRouter (Bearer-only) owns.
// A blanket .use() runs for every request matching the mount prefix
// regardless of whether one of this router's own routes matches it, so it
// would incorrectly intercept (and reject) workflowsRouter's Bearer-authed
// paths like /:id/checks too if this router is mounted first. Scoping auth
// per-route lets Express correctly fall through to workflowsRouter for any
// path that isn't one of this router's three run-related routes.
const workflowParamsSchema = z.object({ id: z.string().uuid() });
// Block 5 (multi-destination fan-out): destNodeIds is a non-empty array —
// FlowCanvas.tsx now sends every destination node in the graph, not just
// "the" one (the old single-destination-per-run scope cut). See
// services/runs.ts's startWorkflowRun for how each id becomes an
// independent run/runId.
const runBodySchema = z.object({ destNodeIds: z.array(z.string().min(1)).min(1) });

// Starts a real ETL run (Phase 6 Block 3) — enqueues the worker's chunked
// runEtl.ts job chain and mints the runId the client streams against via
// GET /:id/run/stream. Gated like /:id/checks (workflows.run, not
// workflows.updateDefinition): this actually moves data, unlike
// preview/mappings-propose. Org-or-personal — scopeFromActor branches on
// whether the actor has an org, and services/runs.ts's startWorkflowRun
// (Block 5, Part 3d) is scope-generic, so no separate requireOrgActor gate
// is needed here.
runsRouter.post(
  "/:id/run",
  requireCookieAuth,
  attachDb,
  attachActor,
  requireCapability("workflows.run"),
  validate({ params: workflowParamsSchema, body: runBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await startWorkflowRun(
      req.withUser,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.destNodeIds,
      req.actor.userId,
    );
    res.status(202).json(data);
  }),
);

const runCancelBodySchema = z.object({ runId: z.string().uuid() });

// Block 3.5 item 3 — cooperative cancel. Auth shape mirrors POST /:id/run
// (requireCapability("workflows.run"), same cookie-auth router): there's no
// separate "cancel" capability in can.ts, and cancelling a run you could
// have started needs no finer gate. The actual authorization check is done
// inside the RPC itself (private.is_member(v_org_id), 0017's
// cancel_workflow_run) against the caller's own req.withUser session — this
// route does no separate ownership resolution first, unlike GET
// /:id/run/stream, since the RPC's own org-membership check already covers
// it and a stale/foreign runId just surfaces as the RPC's "not authorized"
// or "not found" exception via Postgres, caught below and mapped to
// CANCEL_FAILED. Workflow id in the URL is unused past routing/validation
// symmetry with the other two routes; the RPC only needs runId.
runsRouter.post(
  "/:id/run/cancel",
  requireCookieAuth,
  attachDb,
  attachActor,
  requireCapability("workflows.run"),
  validate({ params: workflowParamsSchema, body: runCancelBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    try {
      const { rows } = await req.withUser((db) => db.query("select * from public.cancel_workflow_run($1)", [req.body.runId]));
      const row = rows[0];
      if (!row) throw new AppError(409, "CANCEL_FAILED", "Could not cancel this run.");
      res.status(200).json({ run: row });
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(409, "CANCEL_FAILED", message);
    }
  }),
);

const runStreamQuerySchema = z.object({
  runId: z.string().uuid(),
  // Reconnect-resume, same semantics as GET /chat/stream's ?after=.
  after: z.coerce.number().int().nonnegative().optional(),
});

// SSE relay for a run's progress events (Phase 6 Block 3), mirroring
// GET /chat/stream almost exactly. The one real difference: a run's chunk
// jobs get replaced under fresh BullMQ ids as it progresses, so ownership
// can't always be proven from "the" enqueuing job the way chat's can —
// resolveRunOwnership (services/runs.ts) handles that by falling back to
// the durable, RLS-backed workflow_runs row once the originating job is
// gone, and returns whichever WorkspaceScope proved ownership so the
// channel/replay keys (keyed by scope) line up with what the worker
// actually published to.
runsRouter.get(
  "/:id/run/stream",
  requireCookieAuth,
  attachDb,
  attachActor,
  validate({ params: workflowParamsSchema, query: runStreamQuerySchema }),
  asyncHandler(async (req, res) => {
    if (!req.withUser || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { runId, after } = req.query as unknown as z.infer<typeof runStreamQuerySchema>;

    const ownerScope = await resolveRunOwnership(req.withUser, scopeFromActor(req.actor), runId);
    const channel = channelFor(ownerScope, runId);
    const listKey = replayLogKeyFor(ownerScope, runId);

    await runSse(req, res, {
      heartbeatMs: env.RUN_SSE_HEARTBEAT_MS,
      maxDurationMs: env.RUN_SSE_MAX_DURATION_MS,
      onTimeout: () => ({
        type: "error",
        message: `Stream exceeded max duration (${env.RUN_SSE_MAX_DURATION_MS}ms) without completing.`,
      }),
      run: async (controller) => {
        await subscribeWithReplay<RunStreamEvent>(env.REDIS_URL, {
          channel,
          listKey,
          afterSeq: after,
          signal: controller.signal,
          isTerminal: (event) => event.type === "done" || event.type === "error" || event.type === "cancel",
          onEnvelope: (envelope) => {
            const parsed = RunStreamEvent.safeParse(envelope.event);
            if (!parsed.success) return; // malformed event — drop, don't crash the stream
            controller.send({ seq: envelope.seq, ts: envelope.ts, event: parsed.data });
          },
        });
      },
    });
  }),
);
