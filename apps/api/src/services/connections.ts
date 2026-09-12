import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnectorManifest, type ConfigField, type CredentialRef } from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { dispatchInvalidate, dispatchTest } from "../lib/connectorDispatch.js";
import { logExecutionAudit } from "../lib/executionAudit.js";

export type Connection = {
  id: string;
  connectorId: string;
  handle: string;
  displayName: string;
  ownerUserId: string;
  config: Record<string, unknown>;
  credVersion: number;
  lastTestStatus: "ok" | "error" | null;
  lastTestLatencyMs: number | null;
  lastTestAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const CONNECTIONS_SELECT =
  "id, connector_id, handle, display_name, owner_user_id, config, cred_version, last_test_status, last_test_latency_ms, last_test_at, last_used_at, created_at, updated_at";

type ConnectionRow = {
  id: string;
  connector_id: string;
  handle: string;
  display_name: string;
  owner_user_id: string;
  config: Record<string, unknown>;
  cred_version: number;
  last_test_status: "ok" | "error" | null;
  last_test_latency_ms: number | null;
  last_test_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    connectorId: row.connector_id,
    handle: row.handle,
    displayName: row.display_name,
    ownerUserId: row.owner_user_id,
    config: row.config,
    credVersion: row.cred_version,
    lastTestStatus: row.last_test_status,
    lastTestLatencyMs: row.last_test_latency_ms,
    lastTestAt: row.last_test_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConnections(supabase: SupabaseClient, scope: WorkspaceScope): Promise<Connection[]> {
  let query = supabase.from("connections").select(CONNECTIONS_SELECT);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.order("created_at", { ascending: false });
  return (data ?? []).map((row) => toConnection(row as ConnectionRow));
}

export async function getConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
): Promise<Connection | null> {
  let query = supabase.from("connections").select(CONNECTIONS_SELECT).eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle();
  return data ? toConnection(data as ConnectionRow) : null;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "connection";
}

/** Splits a connector's raw field values into (non-secret) config vs. secret payload, per its manifest.configSchema. */
function splitFields(
  configSchema: ConfigField[],
  fields: Record<string, unknown>,
): { config: Record<string, unknown>; secret: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const field of configSchema) {
    const value = fields[field.key];
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new AppError(400, "MISSING_FIELD", `Missing required field "${field.key}".`);
    }
    if (value === undefined) continue;
    (field.secret ? secret : config)[field.key] = value;
  }
  return { config, secret };
}

const MAX_HANDLE_ATTEMPTS = 20;

export async function createConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  ownerUserId: string,
  input: { connectorId: string; displayName: string; fields: Record<string, unknown> },
): Promise<Connection> {
  const manifest = getConnectorManifest(input.connectorId);
  if (!manifest) throw new AppError(400, "UNKNOWN_CONNECTOR", `No manifest for connector "${input.connectorId}".`);

  // Guard: install-before-connect. No FK enforces this (connector_id is a
  // free-text slug, not a foreign key — manifests are files, not rows), so
  // this is a route-level check, not RLS.
  let installQuery = supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("connector_id", input.connectorId);
  installQuery =
    "orgId" in scope ? installQuery.eq("org_id", scope.orgId) : installQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { count: installCount } = await installQuery;
  if (!installCount) {
    throw new AppError(409, "NOT_INSTALLED", `"${input.connectorId}" must be installed before connecting.`);
  }

  const { config, secret } = splitFields(manifest.configSchema, input.fields);

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", { p_secret: secret });
  if (vaultError || !vaultRef) {
    throw new AppError(500, "VAULT_WRITE_FAILED", vaultError?.message ?? "Failed to store credential.");
  }

  const base = `@${manifest.id}-${slugify(input.displayName)}`;
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
    const handle = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } =
      "orgId" in scope
        ? await supabase
            .from("connections")
            .insert({
              org_id: scope.orgId,
              owner_id: null,
              connector_id: manifest.id,
              handle,
              display_name: input.displayName,
              owner_user_id: ownerUserId,
              config,
              vault_secret_ref: vaultRef as string,
            })
            .select(CONNECTIONS_SELECT)
            .single()
        : await supabase
            .from("connections")
            .insert({
              org_id: null,
              owner_id: scope.ownerId,
              connector_id: manifest.id,
              handle,
              display_name: input.displayName,
              owner_user_id: ownerUserId,
              config,
              vault_secret_ref: vaultRef as string,
            })
            .select(CONNECTIONS_SELECT)
            .single();
    if (!error) return toConnection(data as ConnectionRow);
    if (error.code !== "23505") throw new AppError(500, "CREATE_FAILED", error.message);
    // Unique violation on handle — try the next suffix.
  }
  throw new AppError(409, "HANDLE_EXHAUSTED", `Could not mint a unique handle from "${base}" after ${MAX_HANDLE_ATTEMPTS} attempts.`);
}

/**
 * Config-only update (display name + non-secret manifest fields). Credential
 * rotation (new Vault secret + cred_version bump + /invalidate on the old
 * key) is NOT wired here — that write path doesn't exist yet and is
 * explicitly out of scope for this pass rather than half-built.
 */
export async function updateConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  input: { displayName?: string; fields?: Record<string, unknown> },
): Promise<Connection> {
  const existing = await getConnection(supabase, scope, id);
  if (!existing) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const manifest = getConnectorManifest(existing.connectorId);
  if (!manifest) throw new AppError(500, "UNKNOWN_CONNECTOR", `No manifest for connector "${existing.connectorId}".`);

  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.fields !== undefined) {
    const secretKeys = manifest.configSchema.filter((f) => f.secret).map((f) => f.key);
    for (const key of Object.keys(input.fields)) {
      if (secretKeys.includes(key)) {
        throw new AppError(400, "SECRET_ROTATION_NOT_SUPPORTED", `"${key}" is a credential field — rotation isn't available yet.`);
      }
    }
    patch.config = { ...existing.config, ...input.fields };
  }

  let query = supabase.from("connections").update(patch).eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data, error } = await query.select(CONNECTIONS_SELECT).single();
  if (error) throw new AppError(500, "UPDATE_FAILED", error.message);
  return toConnection(data as ConnectionRow);
}

/**
 * Delete-while-referenced guard is NOT implemented: workflow definitions
 * (workflows.definition jsonb, 0006_workflow_definition.sql) store canvas
 * nodes as opaque JSON with no structured/typed reference to a connectionId
 * anywhere in the codebase yet (no canvas node schema exists in
 * @nia/schemas). A guard here would mean scanning that jsonb for a raw UUID
 * substring — fragile, and as likely to produce a false negative (a
 * differently-shaped reference) as a false positive. This is a real gap,
 * not a nicety, and must be built once the canvas node schema exists rather
 * than guessed at now.
 */
export async function deleteConnection(supabase: SupabaseClient, scope: WorkspaceScope, id: string): Promise<void> {
  const existing = await getConnection(supabase, scope, id);
  if (!existing) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  let query = supabase.from("connections").delete().eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { error } = await query;
  if (error) throw new AppError(500, "DELETE_FAILED", error.message);

  const manifest = getConnectorManifest(existing.connectorId);
  if (manifest) await dispatchInvalidate(manifest, id);
}

export async function testConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  let query = supabase
    .from("connections")
    .select("id, connector_id, handle, config, vault_secret_ref, cred_version, owner_user_id")
    .eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle<{
    id: string;
    connector_id: string;
    handle: string;
    config: Record<string, unknown>;
    vault_secret_ref: string;
    cred_version: number;
    owner_user_id: string;
  }>();
  if (!data) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const manifest = getConnectorManifest(data.connector_id);
  if (!manifest) throw new AppError(500, "UNKNOWN_CONNECTOR", `No manifest for connector "${data.connector_id}".`);

  const credential: CredentialRef = {
    connectionId: data.id,
    credVersion: data.cred_version,
    vaultRef: data.vault_secret_ref,
  };

  const result = await dispatchTest(manifest, credential, data.config);

  // Mirrors connector-mysql's fixed /test probe (services/connector-mysql/
  // src/index.ts) — the only query this connector's /test ever runs.
  await logExecutionAudit(supabase, {
    connectionId: data.id,
    connectionOwnerUserId: data.owner_user_id,
    connectorId: data.connector_id,
    handle: data.handle,
    operation: "test",
    query: "SELECT 1",
    actorUserId,
  });

  await supabase
    .from("connections")
    .update({
      last_test_status: result.ok ? "ok" : "error",
      last_test_latency_ms: result.latencyMs ?? null,
      last_test_at: new Date().toISOString(),
    })
    .eq("id", id);

  return result;
}
