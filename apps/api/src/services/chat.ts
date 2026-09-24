import { workspaceWhere } from "@nia/db";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";

/**
 * Chat now supports org-less "individual" actors (see
 * supabase/migrations/0013_chat_personal_workspace.sql), so every function
 * here takes the full WorkspaceScope union, same as projects.ts/
 * connections.ts, and branches org-scoped vs personal-workspace reads the
 * same way the RLS policies do.
 */

export type Conversation = {
  id: string;
  title: string | null;
  createdBy: string;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ConversationRow = {
  id: string;
  title: string | null;
  created_by: string;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
};

const CONVERSATION_COLUMNS = "id, title, created_by, workflow_id, created_at, updated_at";
const MESSAGE_COLUMNS = "id, role, content, citations, status, created_at";

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
    workflowId: row.workflow_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Array<{ connectionId: string; executedQuery: string; rowCount: number; truncated: boolean }>;
  status: "complete" | "refused" | "error" | "conflict";
  createdAt: string;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatMessage["citations"];
  status: ChatMessage["status"];
  created_at: string;
};

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: row.citations ?? [],
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function listConversations(withUser: WithUser, scope: WorkspaceScope): Promise<Conversation[]> {
  const where = workspaceWhere(scope, 1);
  const { rows } = await withUser((db) =>
    db.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from conversations where ${where.sql} order by updated_at desc`,
      where.params,
    ),
  );
  return rows.map(toConversation);
}

export async function getConversation(withUser: WithUser, scope: WorkspaceScope, id: string): Promise<Conversation | null> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from conversations where id = $1 and ${where.sql}`,
      [id, ...where.params],
    ),
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

/**
 * Latest conversation asked from a given workflow (canvas command bar,
 * Phase 5 Session 4) — the "reopen workflow restores its thread" read
 * path. `null` when no conversation has ever been linked to it yet (a
 * fresh workflow, or one only ever used via /app/chat's own selector).
 */
export async function getLatestConversationForWorkflow(
  withUser: WithUser,
  scope: WorkspaceScope,
  workflowId: string,
): Promise<Conversation | null> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<ConversationRow>(
      `select ${CONVERSATION_COLUMNS} from conversations
       where workflow_id = $1 and ${where.sql}
       order by updated_at desc
       limit 1`,
      [workflowId, ...where.params],
    ),
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

/** Title derived from the first message — matches the design's citation-chip truncation style (14 chars + ellipsis) at a slightly longer, title-appropriate length. */
function deriveTitle(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export async function createConversation(
  withUser: WithUser,
  scope: WorkspaceScope,
  userId: string,
  firstMessage: string,
  workflowId?: string,
): Promise<Conversation> {
  const orgId = "orgId" in scope ? scope.orgId : null;
  const ownerId = "orgId" in scope ? null : scope.ownerId;
  const { rows } = await withUser((db) =>
    db.query<ConversationRow>(
      `insert into conversations (org_id, owner_id, created_by, title, workflow_id)
       values ($1, $2, $3, $4, $5)
       returning ${CONVERSATION_COLUMNS}`,
      [orgId, ownerId, userId, deriveTitle(firstMessage), workflowId ?? null],
    ),
  );
  const data = rows[0];
  if (!data) throw new Error("Failed to create conversation.");
  return toConversation(data);
}

export async function listMessages(
  withUser: WithUser,
  scope: WorkspaceScope,
  conversationId: string,
): Promise<ChatMessage[]> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<MessageRow>(
      `select ${MESSAGE_COLUMNS} from messages
       where conversation_id = $1 and ${where.sql}
       order by created_at asc`,
      [conversationId, ...where.params],
    ),
  );
  return rows.map(toMessage);
}

export async function insertUserMessage(
  withUser: WithUser,
  scope: WorkspaceScope,
  conversationId: string,
  content: string,
): Promise<ChatMessage> {
  const orgId = "orgId" in scope ? scope.orgId : null;
  const ownerId = "orgId" in scope ? null : scope.ownerId;
  const { rows } = await withUser((db) =>
    db.query<MessageRow>(
      `insert into messages (org_id, owner_id, conversation_id, role, content, citations)
       values ($1, $2, $3, 'user', $4, '[]'::jsonb)
       returning ${MESSAGE_COLUMNS}`,
      [orgId, ownerId, conversationId, content],
    ),
  );
  const data = rows[0];
  if (!data) throw new Error("Failed to persist user message.");
  return toMessage(data);
}
