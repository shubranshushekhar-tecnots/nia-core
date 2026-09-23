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
import { createClient } from "@supabase/supabase-js";
import { env } from "../../env.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
export const INVALID_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";

const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

export type ConnectorId = keyof typeof SANDBOX;

export async function getOrgId(): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(orgId: string, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];

  const { count: installCount } = await supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-eval`;
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("connections")
      .update({ config: { host, port, database } })
      .eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", {
    p_secret: { user, password },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Golden eval (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
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
  const { data, error } = await supabase
    .from("conversations")
    .insert({ org_id: orgId, created_by: DEMO_USER_ID })
    .select("id")
    .single();
  if (error || !data) throw new Error(`conversation insert failed: ${error?.message}`);
  return data.id as string;
}

/** Reads back the assistant message row a chat job persisted, for scoring. */
export async function getAssistantMessage(
  conversationId: string,
): Promise<{ content: string; citations: { connectionId: string; executedQuery: string; rowCount: number; truncated: boolean }[]; status: string } | null> {
  const { data, error } = await supabase
    .from("messages")
    .select("content, citations, status")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { content: string; citations: { connectionId: string; executedQuery: string; rowCount: number; truncated: boolean }[]; status: string };
}
