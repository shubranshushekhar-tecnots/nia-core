import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceScope } from "../lib/workspaceScope.js";

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
  createdAt: string;
  updatedAt: string;
};

type ConversationRow = {
  id: string;
  title: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
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

export async function listConversations(supabase: SupabaseClient, scope: WorkspaceScope): Promise<Conversation[]> {
  let query = supabase.from("conversations").select("id, title, created_by, created_at, updated_at");
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("updated_at", { ascending: false });
  return (data ?? []).map((row) => toConversation(row as ConversationRow));
}

export async function getConversation(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
): Promise<Conversation | null> {
  let query = supabase.from("conversations").select("id, title, created_by, created_at, updated_at").eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle();
  return data ? toConversation(data as ConversationRow) : null;
}

/** Title derived from the first message — matches the design's citation-chip truncation style (14 chars + ellipsis) at a slightly longer, title-appropriate length. */
function deriveTitle(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

export async function createConversation(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  userId: string,
  firstMessage: string,
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      org_id: "orgId" in scope ? scope.orgId : null,
      owner_id: "orgId" in scope ? null : scope.ownerId,
      created_by: userId,
      title: deriveTitle(firstMessage),
    })
    .select("id, title, created_by, created_at, updated_at")
    .single();
  if (error || !data) throw error ?? new Error("Failed to create conversation.");
  return toConversation(data as ConversationRow);
}

export async function listMessages(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  conversationId: string,
): Promise<ChatMessage[]> {
  let query = supabase
    .from("messages")
    .select("id, role, content, citations, status, created_at")
    .eq("conversation_id", conversationId);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("created_at", { ascending: true });
  return (data ?? []).map((row) => toMessage(row as MessageRow));
}

export async function insertUserMessage(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  conversationId: string,
  content: string,
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      org_id: "orgId" in scope ? scope.orgId : null,
      owner_id: "orgId" in scope ? null : scope.ownerId,
      conversation_id: conversationId,
      role: "user",
      content,
      citations: [],
    })
    .select("id, role, content, citations, status, created_at")
    .single();
  if (error || !data) throw error ?? new Error("Failed to persist user message.");
  return toMessage(data as MessageRow);
}
