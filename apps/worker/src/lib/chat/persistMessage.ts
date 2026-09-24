import { withServiceRole, type WorkspaceScope } from "@nia/db";
import { dbPool } from "../dbPool.js";

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
 * graphs). Uses withServiceRole (@nia/db) because RLS forbids any
 * authenticated client from ever inserting role='assistant' rows
 * (supabase/migrations/0010_chat_conversations.sql's
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
  try {
    await withServiceRole(dbPool, (db) =>
      db.query(
        `insert into public.messages (conversation_id, org_id, owner_id, role, content, citations, status)
         values ($1, $2, $3, 'assistant', $4, $5, $6)`,
        [
          params.conversationId,
          "orgId" in params.scope ? params.scope.orgId : null,
          "orgId" in params.scope ? null : params.scope.ownerId,
          params.content,
          JSON.stringify(params.citations),
          params.status,
        ],
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] failed to persist assistant message for conversation ${params.conversationId}:`, message);
  }
}
