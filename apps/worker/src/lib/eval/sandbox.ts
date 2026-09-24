/**
 * Same seeding conventions as scripts/chat-smoke.ts (service-role Supabase
 * client, docker-compose service names/internal ports for `config` since
 * the connector SERVICE containers dial that, not this process) — factored
 * out here rather than duplicated inline because both chat-smoke.ts and the
 * golden-set eval runner need the identical 3-connector demo-org setup.
 * chat-smoke.ts keeps its own copy (predates this module, already verified,
 * not worth the regression risk of switching it over) — this is genuinely
 * a second, independent seeding call site for a second script.
 */
import { withServiceRole, workspaceWhere } from "@nia/db";
import { dbPool } from "../dbPool.js";

export const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
export const INVALID_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";

const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

export type ConnectorId = keyof typeof SANDBOX;

export async function getOrgId(): Promise<string> {
  try {
    const result = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>("select id from public.organizations where slug = $1", ["icecream-co"]),
    );
    const row = result.rows[0];
    if (!row) throw new Error("no row returned");
    return row.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not find seed.sql's demo org: ${message}`);
  }
}

async function seedConnection(orgId: string, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];
  const where = workspaceWhere({ orgId }, 1);

  const installExists = await withServiceRole(dbPool, (db) =>
    db.query(`select id from public.connector_installs where ${where.sql} and connector_id = $2`, [...where.params, connectorId]),
  );
  if (installExists.rows.length === 0) {
    try {
      await withServiceRole(dbPool, (db) =>
        db.query("insert into public.connector_installs (org_id, connector_id, installed_by_user_id) values ($1, $2, $3)", [
          orgId,
          connectorId,
          DEMO_USER_ID,
        ]),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`install ${connectorId} failed: ${message}`);
    }
  }

  const handle = `@${connectorId}-eval`;
  const existingResult = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(`select id from public.connections where ${where.sql} and handle = $2`, [...where.params, handle]),
  );
  const existing = existingResult.rows[0] ?? null;
  if (existing) {
    try {
      await withServiceRole(dbPool, (db) =>
        db.query("update public.connections set config = $1 where id = $2", [JSON.stringify({ host, port, database }), existing.id]),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`connection config update for ${connectorId} failed: ${message}`);
    }
    return existing.id;
  }

  let vaultRef: string;
  try {
    const result = await withServiceRole(dbPool, (db) =>
      db.query<{ create_connector_secret: string }>("select public.create_connector_secret($1::jsonb) as create_connector_secret", [
        JSON.stringify({ user, password }),
      ]),
    );
    const ref = result.rows[0]?.create_connector_secret;
    if (!ref) throw new Error("no ref returned");
    vaultRef = ref;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`vault write for ${connectorId} failed: ${message}`);
  }

  try {
    const result = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>(
        `insert into public.connections (org_id, owner_id, connector_id, handle, display_name, owner_user_id, config, vault_secret_ref)
         values ($1, null, $2, $3, $4, $5, $6, $7)
         returning id`,
        [orgId, connectorId, handle, `Golden eval (${connectorId})`, DEMO_USER_ID, JSON.stringify({ host, port, database }), vaultRef],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new Error("no row returned");
    return row.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`connection insert for ${connectorId} failed: ${message}`);
  }
}

export async function seedSandbox(): Promise<{ orgId: string; connectionIds: Record<ConnectorId, string> }> {
  const orgId = await getOrgId();
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection(orgId, "mysql"),
    mongodb: await seedConnection(orgId, "mongodb"),
    supabase: await seedConnection(orgId, "supabase"),
  };
  return { orgId, connectionIds };
}

/**
 * The `messages` table FKs conversation_id -> conversations.id (see
 * 0010_chat_conversations.sql) — persistAssistantMessage silently no-ops on
 * a foreign-key violation (logged, not thrown, since a chat job must never
 * crash the pipeline over an audit-trail write), so a golden case run
 * against a conversationId with no real row would score as a false
 * citation/content failure rather than a loud error. Real traffic always
 * has this row created by apps/web before a chat job is ever enqueued; the
 * eval runner has to do the same.
 */
export async function createConversation(orgId: string): Promise<string> {
  try {
    const result = await withServiceRole(dbPool, (db) =>
      db.query<{ id: string }>("insert into public.conversations (org_id, created_by) values ($1, $2) returning id", [orgId, DEMO_USER_ID]),
    );
    const row = result.rows[0];
    if (!row) throw new Error("no row returned");
    return row.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`conversation insert failed: ${message}`);
  }
}

/** Reads back the assistant message row a chat job persisted, for scoring. */
export async function getAssistantMessage(
  conversationId: string,
): Promise<{ content: string; citations: { connectionId: string; executedQuery: string; rowCount: number; truncated: boolean }[]; status: string } | null> {
  type MessageRow = {
    content: string;
    citations: { connectionId: string; executedQuery: string; rowCount: number; truncated: boolean }[];
    status: string;
  };
  try {
    const result = await withServiceRole(dbPool, (db) =>
      db.query<MessageRow>(
        `select content, citations, status from public.messages
         where conversation_id = $1 and role = 'assistant'
         order by created_at desc
         limit 1`,
        [conversationId],
      ),
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}
