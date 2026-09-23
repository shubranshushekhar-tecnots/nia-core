import { randomUUID } from "node:crypto";
import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { ChatStreamEvent, MAX_SOURCES } from "@nia/schemas";
import { requireCookieAuth } from "../middleware/cookieAuth.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { runSse, subscribeWithReplay } from "../lib/sse.js";
import { enqueueChatQuery, getChatJobData } from "../lib/chatQueue.js";
import { channelFor, replayLogKeyFor } from "../lib/chatChannel.js";
import { scopeFromActor, type WorkspaceScope } from "../lib/workspaceScope.js";
import { env } from "../env.js";
import { createConversation, getConversation, insertUserMessage, listConversations, listMessages } from "../services/chat.js";

/**
 * Real home of the chat enqueue + SSE relay, replacing
 * apps/web/src/app/api/chat/route.ts + lib/chat/{queue,subscribe}.ts.
 * Reached same-origin from the browser via apps/web's /api/backend/:path*
 * rewrite (next.config.mjs) so the httpOnly Supabase session cookies flow
 * here without CORS — requireCookieAuth reads them directly.
 *
 * Chat works for org-less "individual" actors too (see
 * supabase/migrations/0013_chat_personal_workspace.sql) — no requireOrgActor
 * gate here, unlike routes that truly need an org. Every handler derives a
 * WorkspaceScope via scopeFromActor instead of assuming req.actor!.org.
 */
export const chatRouter: ExpressRouter = Router();

chatRouter.use(requireCookieAuth, attachActor);

/** Structural equality for the org/owner XOR union — no shared discriminant to switch on. */
function sameScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return ("orgId" in a && "orgId" in b && a.orgId === b.orgId) || ("ownerId" in a && "ownerId" in b && a.ownerId === b.ownerId);
}

/**
 * 1-MAX_SOURCES connectionIds — the worker's multiSource pipeline
 * (apps/worker/src/lib/chat/multiSource/) already supports this range;
 * this mirrors its own capacity-limit refusal so an obviously-oversized
 * request fails fast here instead of enqueuing a job that will just be
 * refused downstream (Phase 5 Session 4 — previously hard-capped at
 * exactly 1, which was stale relative to the worker's actual support).
 */
const ChatRequestBody = z.object({
  // Absent on the first turn of a new thread — the route creates the
  // conversation row itself (see below) rather than requiring the client
  // to pre-generate a uuid, since only the server can satisfy
  // conversations_insert_members' created_by = auth.uid() check.
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1),
  connectionIds: z.array(z.string().uuid()),
  // Only consulted when creating a new conversation (no conversationId
  // passed) — links it to the workflow it was asked from (canvas command
  // bar) so reopening the workflow can restore the thread. Ignored when
  // continuing an existing conversation (its workflow_id, if any, is
  // already set).
  workflowId: z.string().uuid().optional(),
});

chatRouter.post(
  "/chat",
  validate({ body: ChatRequestBody }),
  asyncHandler(async (req, res) => {
    const { conversationId, message, connectionIds, workflowId } = req.body as z.infer<typeof ChatRequestBody>;

    if (connectionIds.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "No connection selected — mention a connection to run this query against.");
    }
    if (connectionIds.length > MAX_SOURCES) {
      throw new AppError(400, "VALIDATION_ERROR", `Too many connections selected — at most ${MAX_SOURCES} at once.`);
    }

    const scope = scopeFromActor(req.actor!);
    const userId = req.actor!.userId;

    let resolvedConversationId = conversationId;
    if (resolvedConversationId) {
      // Must already exist in this workspace — insertUserMessage's own RLS-
      // backed insert (via req.supabase) additionally requires it be *this
      // user's* conversation (messages_insert_own_user_messages), so an
      // existing-but-foreign-or-another-member's id fails there with a
      // clean 500 -> caught by getConversation's null check first for a
      // clearer 404.
      const existing = await getConversation(req.supabase!, scope, resolvedConversationId);
      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "No conversation found for that id.");
      }
    } else {
      const created = await createConversation(req.supabase!, scope, userId, message, workflowId);
      resolvedConversationId = created.id;
    }

    await insertUserMessage(req.supabase!, scope, resolvedConversationId, message);

    // Own id, not BullMQ's default — this is what the client later passes
    // back to GET /chat/stream?jobId= to find this exact job.
    const jobId = randomUUID();
    await enqueueChatQuery(jobId, {
      kind: "chat_query",
      scope,
      userId,
      conversationId: resolvedConversationId,
      message,
      connectionIds,
    });

    res.status(202).json({ jobId, conversationId: resolvedConversationId });
  }),
);

chatRouter.get(
  "/chat/conversations",
  asyncHandler(async (req, res) => {
    const conversations = await listConversations(req.supabase!, scopeFromActor(req.actor!));
    res.json(conversations);
  }),
);

const ConversationParams = z.object({ id: z.string().uuid() });

chatRouter.get(
  "/chat/conversations/:id/messages",
  validate({ params: ConversationParams }),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof ConversationParams>;
    const scope = scopeFromActor(req.actor!);
    const conversation = await getConversation(req.supabase!, scope, id);
    if (!conversation) {
      throw new AppError(404, "NOT_FOUND", "No conversation found for that id.");
    }
    const messages = await listMessages(req.supabase!, scope, id);
    res.json(messages);
  }),
);

const ChatStreamQuery = z.object({
  jobId: z.string().uuid(),
  // Reconnect-resume: skip everything already delivered up through this
  // seq. Absent (or 0) on a fresh connection, which naturally replays the
  // job's entire event log from the start.
  after: z.coerce.number().int().nonnegative().optional(),
});

chatRouter.get(
  "/chat/stream",
  validate({ query: ChatStreamQuery }),
  asyncHandler(async (req, res) => {
    const { jobId, after } = req.query as unknown as z.infer<typeof ChatStreamQuery>;

    const jobData = await getChatJobData(jobId);
    if (!jobData) {
      throw new AppError(404, "NOT_FOUND", "No chat job found for that id.");
    }
    // Ownership check before ever subscribing. There's no `conversations`
    // table to query RLS against — conversationId is a purely ephemeral,
    // client-generated grouping id, never persisted. jobData.scope is the
    // real trust anchor: it was set server-side from the enqueuing actor's
    // scope (routes/chat.ts's POST /chat), never client-supplied at read
    // time, so comparing it against the *requesting* actor's own scope
    // (also RLS-resolved, via attachActor) is the equivalent check.
    if (!sameScope(jobData.scope, scopeFromActor(req.actor!))) {
      throw new AppError(403, "FORBIDDEN", "You don't have access to this chat job.");
    }

    const channel = channelFor(jobData.scope, jobId);
    const listKey = replayLogKeyFor(jobData.scope, jobId);

    await runSse(req, res, {
      heartbeatMs: env.CHAT_SSE_HEARTBEAT_MS,
      maxDurationMs: env.CHAT_SSE_MAX_DURATION_MS,
      onTimeout: () => ({
        type: "error",
        message: `Stream exceeded max duration (${env.CHAT_SSE_MAX_DURATION_MS}ms) without completing.`,
      }),
      run: async (controller) => {
        await subscribeWithReplay<ChatStreamEvent>(env.REDIS_URL, {
          channel,
          listKey,
          afterSeq: after,
          signal: controller.signal,
          // All 4 terminal ChatStreamEvent kinds close the stream — this
          // previously only listed done/error, leaving refused/conflict
          // streams hanging open until the max-duration timeout (found
          // during the chat-surface gap audit).
          isTerminal: (event) =>
            event.type === "done" || event.type === "error" || event.type === "refused" || event.type === "conflict",
          onEnvelope: (envelope) => {
            const parsed = ChatStreamEvent.safeParse(envelope.event);
            if (!parsed.success) return; // malformed event — drop, don't crash the stream
            controller.send({ seq: envelope.seq, ts: envelope.ts, event: parsed.data });
          },
        });
      },
    });
  }),
);
