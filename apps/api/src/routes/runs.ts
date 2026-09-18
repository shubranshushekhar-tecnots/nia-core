import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { RunStreamEvent } from "@nia/schemas";
import { requireCookieAuth } from "../middleware/cookieAuth.js";
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
 */
export const runsRouter: ExpressRouter = Router();

runsRouter.use(requireCookieAuth, attachActor);

const workflowParamsSchema = z.object({ id: z.string().uuid() });
const runBodySchema = z.object({ destNodeId: z.string().min(1) });

// Starts a real ETL run (Phase 6 Block 3) — enqueues the worker's chunked
// runEtl.ts job chain and mints the runId the client streams against via
// GET /:id/run/stream. Gated like /:id/checks (workflows.run, not
// workflows.updateDefinition): this actually moves data, unlike
// preview/mappings-propose. Org-only — services/runs.ts's startWorkflowRun
// refuses a personal-workspace actor with a clean 400 (EtlRunJob has no
// personal-workspace scope yet, see its own header comment), so there's no
// separate requireOrgActor gate here.
runsRouter.post(
  "/workflows/:id/run",
  requireCapability("workflows.run"),
  validate({ params: workflowParamsSchema, body: runBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const data = await startWorkflowRun(
      req.supabase,
      scopeFromActor(req.actor),
      req.params.id!,
      req.body.destNodeId,
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
// cancel_workflow_run) against the caller's own req.supabase session — this
// route does no separate ownership resolution first, unlike GET
// /:id/run/stream, since the RPC's own org-membership check already covers
// it and a stale/foreign runId just surfaces as the RPC's "not authorized"
// or "not found" exception via Postgres, mapped by asyncHandler like any
// other supabase-js error. Workflow id in the URL is unused past routing/
// validation symmetry with the other two routes; the RPC only needs runId.
runsRouter.post(
  "/workflows/:id/run/cancel",
  requireCapability("workflows.run"),
  validate({ params: workflowParamsSchema, body: runCancelBodySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { data, error } = await req.supabase.rpc("cancel_workflow_run", { p_run_id: req.body.runId });
    if (error) throw new AppError(409, "CANCEL_FAILED", error.message);
    res.status(200).json({ run: data });
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
  "/workflows/:id/run/stream",
  validate({ params: workflowParamsSchema, query: runStreamQuerySchema }),
  asyncHandler(async (req, res) => {
    if (!req.supabase || !req.actor) throw new AppError(401, "NOT_AUTHENTICATED", "Not authenticated.");
    const { runId, after } = req.query as unknown as z.infer<typeof runStreamQuerySchema>;

    const ownerScope = await resolveRunOwnership(req.supabase, scopeFromActor(req.actor), runId);
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
