import { Router, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireCookieAuth } from "../middleware/cookieAuth.js";
import { attachDb } from "../middleware/db.js";
import { attachActor } from "../middleware/actor.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { AppError } from "../lib/appError.js";
import { getActingUser } from "../copilot/actingUser.js";
import { runAgentTurn } from "../copilot/agentLoop.js";
import { executeTool } from "../copilot/executeTool.js";
import { confirmPendingAction, getPendingAction } from "../copilot/pendingActions.js";
import type { ChatMessage } from "../copilot/gatewayClient.js";

/**
 * Copilot agent (Part 4 loop, Part 3 confirmation). Cookie-authenticated
 * like chatRouter — this is the new agentic surface, deliberately separate
 * from POST /chat (the existing single-shot propose/validate/apply flow,
 * still exercised by copilot.spec.ts's original two tests and untouched
 * by this plan). Mounted at "/copilot-agent"; workflowId is an argument on
 * each tool call (per-tool inputSchema), not a URL param, since a single
 * agent turn can touch more than one workflow's tools in principle.
 *
 * Deliberately stateless: the client resends the whole message history
 * each turn (no server-side conversation row for this new surface) — the
 * plan doesn't ask for persistence here, unlike POST /chat's conversations
 * table.
 */
export const copilotAgentRouter: ExpressRouter = Router();

copilotAgentRouter.use(requireCookieAuth, attachDb, attachActor);

const AgentMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const AgentTurnBody = z.object({
  messages: z.array(AgentMessage).min(1),
});

copilotAgentRouter.post(
  "/",
  validate({ body: AgentTurnBody }),
  asyncHandler(async (req, res) => {
    const user = getActingUser(req);
    const { messages } = req.body as z.infer<typeof AgentTurnBody>;
    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const result = await runAgentTurn(req.withUser!, user, history);
    res.json(result);
  }),
);

const ConfirmParams = z.object({ id: z.string().uuid() });

/**
 * Part 3's ONE confirmation entry point. Real, unforgeable user click
 * required to reach this route (cookie session, not the model). Confirms
 * the pending action, then re-runs the exact tool it was created for with
 * pendingActionId set — the only place in this codebase that ever passes
 * pendingActionId into executeTool.
 */
copilotAgentRouter.post(
  "/pending-actions/:id/confirm",
  validate({ params: ConfirmParams }),
  asyncHandler(async (req, res) => {
    const user = getActingUser(req);
    const { id } = req.params as unknown as z.infer<typeof ConfirmParams>;

    const pending = await getPendingAction(req.withUser!, id);
    if (!pending) throw new AppError(404, "NOT_FOUND", "No pending action found for that id.");

    await confirmPendingAction(req.withUser!, id);
    const result = await executeTool(req.withUser!, user, pending.tool, pending.args, {
      pendingActionId: id,
    });
    res.json(result);
  }),
);
