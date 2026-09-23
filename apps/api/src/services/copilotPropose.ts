import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanProposeOutcome } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { runPlanProposeJob } from "../lib/planQueue.js";
import { getConversation, createConversation } from "./chat.js";

async function assertWorkflowInScope(supabase: SupabaseClient, scope: WorkspaceScope, workflowId: string): Promise<void> {
  let query = supabase.from("workflows").select("id", { count: "exact", head: true }).eq("id", workflowId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count } = await query;
  if (!count) throw new AppError(404, "NOT_FOUND", "Workflow not found.");
}

export type ProposePlanResult = { conversationId: string; outcome: PlanProposeOutcome };

/**
 * Phase 7 Session 3 — Copilot "propose". Same shape as
 * proposeMappingForWorkflow (services/mappings.ts): scope-check, then
 * delegate to the worker via a synchronous queue helper (planQueue.ts),
 * no persistence step of its own. `runPlanPropose`'s conversationId field
 * is a required pass-through (not currently read by generatePlan's
 * prompt — grepped, no references), so this resolves/creates one exactly
 * the way POST /chat's route already does (reusing getConversation/
 * createConversation, not duplicating that logic): validates a
 * caller-supplied id is actually in scope and linked to this workflow, or
 * creates a fresh conversation linked to workflowId if none is supplied.
 *
 * Deliberately does NOT call insertUserMessage — a plan proposal renders
 * as a ghost preview on the canvas, not a chat bubble; Session 1 never
 * built message-persistence for plan turns either.
 */
export async function proposePlanForWorkflow(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  workflowId: string,
  userId: string,
  message: string,
  conversationId?: string,
): Promise<ProposePlanResult> {
  await assertWorkflowInScope(supabase, scope, workflowId);

  let resolvedConversationId = conversationId;
  if (resolvedConversationId) {
    const existing = await getConversation(supabase, scope, resolvedConversationId);
    if (!existing) throw new AppError(404, "NOT_FOUND", "Conversation not found.");
  } else {
    const created = await createConversation(supabase, scope, userId, message, workflowId);
    resolvedConversationId = created.id;
  }

  const outcome = await runPlanProposeJob({
    scope,
    userId,
    workflowId,
    conversationId: resolvedConversationId,
    message,
    triggeredByUserId: userId,
  });

  return { conversationId: resolvedConversationId, outcome };
}
