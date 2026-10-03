import type { Pool } from "pg";
import { withServiceRole, workspaceWhere } from "@nia/db";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";

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

/**
 * Subscription Phase 3, Slice 3: a Copilot action is one user request (not
 * each internal tool call — decision 3), checked before the request is
 * enqueued and, if allowed, recorded in the same call so the check and the
 * count can never race apart. `pg_advisory_xact_lock` serializes concurrent
 * requests from the same workspace for the lifetime of this transaction
 * (auto-released on commit/rollback, same guarantee `SET LOCAL ROLE` relies
 * on — see packages/db/src/client.ts) so two requests arriving at the
 * boundary can never both pass. Unlike rows (Free-only hard stop), Copilot
 * hard-stops on every metered plan (decision 5) — a null
 * copilot_actions_per_month means unmetered (legacy/enterprise).
 *
 * subjectId is the chat job's id (routes/chat.ts generates it before any
 * write, one per request), so a blocked request never leaves an orphaned
 * conversation/message row behind — usage_events' unique (kind, subject_id)
 * index makes a duplicate insert for the same job a no-op.
 */
export async function assertCopilotActionAllowed(pool: Pool, scope: WorkspaceScope, subjectId: string): Promise<void> {
  const isPersonal = !("orgId" in scope);
  const table = isPersonal ? "owner_plan" : "org_plan";
  const scopeColumn = isPersonal ? "user_id" : "org_id";
  const scopeValue = isPersonal ? scope.ownerId : scope.orgId;
  const lockKey = isPersonal ? `owner:${scope.ownerId}` : `org:${scope.orgId}`;

  // withServiceRole here is the same "deliberate, narrow exception" to
  // apps/api's general never-withServiceRole rule (lib/dbPool.ts's header
  // comment) that requireStaff.ts/billingWebhook.ts already established:
  // usage_events has no insert/update/delete grant for `authenticated` at
  // all (0066_usage_events.sql — written exclusively via service_role, by
  // design), so running the advisory lock + plan/usage check + insert as
  // `authenticated` can never succeed (the bug this fixes). It is not a
  // general RLS bypass for ordinary application data: every query below is
  // still explicitly filtered by `scope` (org_id/owner_id), and `scope`
  // itself was already resolved from the verified session before this
  // function is ever called — the org/project access check happens in
  // middleware/actor.ts's attachActor (DB-backed organization_members
  // lookup keyed on the authenticated user id) and
  // lib/workspaceScope.ts's scopeFromActor, both upstream of
  // routes/chat.ts's call to this function, never from the request body.
  await withServiceRole(pool, async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);

    const { rows: planRows } = await db.query<{ plan_name: string; action_limit: number | null }>(
      `select pl.name as plan_name, pl.copilot_actions_per_month as action_limit
       from public.${table} op
       join public.plans pl on pl.id = op.plan_id
       where op.${scopeColumn} = $1`,
      [scopeValue],
    );
    const plan = planRows[0];
    // Metered plans (limit not null) get a hard stop at 100% on every one
    // of them (decision 5) — unlike rows, this isn't Free-only. Legacy/
    // enterprise (null limit) and a missing plan row are both unmetered:
    // skip the check, but still record below — usage is tracked per
    // workspace regardless of plan (decision 1), so Console (Slice 5) can
    // show it even for unmetered workspaces.
    if (plan && plan.action_limit !== null) {
      const where = workspaceWhere(scope, 1);
      const { rows: usageRows } = await db.query<{ used: string | null }>(
        `select sum(quantity)::bigint as used
         from public.usage_events
         where kind = 'copilot_action'
           and ${where.sql}
           and occurred_at >= date_trunc('month', now())`,
        where.params,
      );
      const used = Number(usageRows[0]?.used ?? 0);
      if (used >= plan.action_limit) {
        throw new AppError(
          403,
          "COPILOT_LIMIT_EXCEEDED",
          `Your ${plan.plan_name} plan includes ${plan.action_limit.toLocaleString()} Copilot actions a month, and this workspace has already used all of them. Upgrade to keep using Copilot this month.`,
        );
      }
    }

    const orgId = "orgId" in scope ? scope.orgId : null;
    const ownerId = "orgId" in scope ? null : scope.ownerId;
    await db.query(
      `insert into public.usage_events (org_id, owner_id, kind, quantity, subject_id)
       values ($1, $2, 'copilot_action', 1, $3)
       on conflict (kind, subject_id) do nothing`,
      [orgId, ownerId, subjectId],
    );
  });
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
