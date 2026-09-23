import { supabase } from "../supabaseClient.js";
import type { WorkspaceScope } from "../workspaceScope.js";

/** Subset of TabularMeta (@nia/schemas' tabular.ts) persisted per citation. */
export interface PersistedCitation {
  connectionId: string;
  executedQuery: string;
  rowCount: number;
  truncated: boolean;
}

export type AssistantMessageStatus = "complete" | "refused" | "error" | "conflict";

/**
 * Writes the final assistant message row once a chat job reaches a
 * terminal state (done/refused/error/conflict — see index.ts's call
 * sites, one per terminal branch of both the single- and multi-source
 * graphs). Uses the service-role client (supabaseClient.ts) because RLS
 * forbids any authenticated client from ever inserting role='assistant'
 * rows (supabase/migrations/0010_chat_conversations.sql's
 * messages_insert_own_user_messages policy hard-requires role='user') —
 * scope/conversationId here come straight from the trusted BullMQ job
 * payload, never re-derived from anything client-controlled, so this is
 * safe by construction despite bypassing RLS. scope can be org- or
 * owner-scoped (supabase/migrations/0013_chat_personal_workspace.sql), so
 * the insert sets exactly one of org_id/owner_id per the XOR constraint.
 *
 * Best-effort: a persistence failure must never crash the job after the
 * SSE stream has already delivered the terminal event to the browser —
 * log and move on rather than throw.
 */
export async function persistAssistantMessage(params: {
  scope: WorkspaceScope;
  conversationId: string;
  content: string;
  citations: PersistedCitation[];
  status: AssistantMessageStatus;
}): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: params.conversationId,
    org_id: "orgId" in params.scope ? params.scope.orgId : null,
    owner_id: "orgId" in params.scope ? null : params.scope.ownerId,
    role: "assistant",
    content: params.content,
    citations: params.citations,
    status: params.status,
  });
  if (error) {
    console.error(
      `[chat] failed to persist assistant message for conversation ${params.conversationId}:`,
      error.message,
    );
  }
}
