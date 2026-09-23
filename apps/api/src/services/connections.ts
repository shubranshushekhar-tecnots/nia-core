import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getConnectorManifest,
  EntityProfile,
  GraphDoc,
  type ConfigField,
  type CredentialRef,
  type IntrospectResponse,
  type EntityRef,
} from "@nia/schemas";
import type { WorkspaceScope } from "../lib/workspaceScope.js";
import { AppError } from "../lib/appError.js";
import { dispatchInvalidate, dispatchIntrospect, dispatchTest } from "../lib/connectorDispatch.js";
import { logExecutionAudit } from "../lib/executionAudit.js";
import { getCachedSchema, setCachedSchema, invalidateCachedSchema } from "../lib/schemaCache.js";
import { runSchemaRefreshJob } from "../lib/schemaRefreshQueue.js";
import { runProfileJob } from "../lib/profileQueue.js";

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

// Item 4.2 fix (fix-chain plan): the web form already trims non-secret text
// fields and validates nothing server-side (apps/web/src/lib/connections/
// actions.ts) — but that's a UI convenience, not a trust boundary. Any other
// caller of this API (a client with JS bypassed, a future integration) could
// previously reach the connector/pool layer with an untrimmed or malformed
// `host`, which — beyond just "looking wrong" — silently breaks TLS SNI
// (see pool-manager.ts's `resolveSsl`/`parsePostgresConfig`) and can, for
// odd-enough characters, be an SSRF-relevant free-text field. Never trims
// `password`/secret fields (leading/trailing whitespace can be part of a
// real secret).
const HOST_CHARACTER_PATTERN = /^[a-zA-Z0-9.-]+$/;

function normalizeAndValidateConfigValue(field: ConfigField, value: unknown): unknown {
  if (field.secret || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (field.key === "host" && trimmed && !HOST_CHARACTER_PATTERN.test(trimmed)) {
    throw new AppError(
      400,
      "INVALID_FIELD",
      `Field "host" must not contain whitespace and may only contain letters, digits, dots, and hyphens.`,
    );
  }
  return trimmed;
}

/** Splits a connector's raw field values into (non-secret) config vs. secret payload, per its manifest.configSchema. */
function splitFields(
  configSchema: ConfigField[],
  fields: Record<string, unknown>,
): { config: Record<string, unknown>; secret: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const field of configSchema) {
    const value = normalizeAndValidateConfigValue(field, fields[field.key]);
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new AppError(400, "MISSING_FIELD", `Missing required field "${field.key}".`);
    }
    if (value === undefined) continue;
    (field.secret ? secret : config)[field.key] = value;
  }
  return { config, secret };
}

/**
 * Same split as splitFields, for updateConnection's edit flow: non-secret
 * fields are still required as normal, but secret fields are NEVER
 * required — a blank/omitted secret field means "keep the stored value",
 * not "clear it", so it's simply absent from the returned `secret`
 * payload rather than raising MISSING_FIELD.
 */
function splitFieldsForEdit(
  configSchema: ConfigField[],
  fields: Record<string, unknown>,
): { config: Record<string, unknown>; secret: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const field of configSchema) {
    if (field.secret) {
      const value = fields[field.key];
      if (value === undefined || value === null || value === "") continue;
      secret[field.key] = value;
      continue;
    }
    const value = normalizeAndValidateConfigValue(field, fields[field.key]);
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new AppError(400, "MISSING_FIELD", `Missing required field "${field.key}".`);
    }
    if (value === undefined) continue;
    config[field.key] = value;
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
    // Two distinct unique constraints can raise 23505 here: the handle
    // uniqueness this retry loop is built to work around, and
    // connections_scope_display_name_unique_idx (0029, Item 6.1) on
    // display_name — a display_name collision won't go away by retrying
    // with a new handle suffix (display_name doesn't change across
    // attempts), so it must be surfaced immediately rather than exhausting
    // every attempt only to report the wrong error (HANDLE_EXHAUSTED).
    if (error.message.includes("connections_scope_display_name_unique_idx")) {
      throw new AppError(409, "NAME_TAKEN", `A connection named "${input.displayName}" already exists.`);
    }
    // Unique violation on handle — try the next suffix.
  }
  throw new AppError(409, "HANDLE_EXHAUSTED", `Could not mint a unique handle from "${base}" after ${MAX_HANDLE_ATTEMPTS} attempts.`);
}

export type ConnectionUsage = { id: string; name: string; nodeCount: number; cleanPlanCount: number };

/**
 * Scans every workflow_graphs row in scope for canvas nodes whose
 * connectionId matches, and reports the CleanPlan bindings on those same
 * (workflow_id, node_id) pairs. No GIN index on workflow_graphs.graph (see
 * 0012's header comment) and no structured connectionId column to filter
 * on server-side, so this parses each row's graph client-side in this
 * process rather than pushing a jsonb predicate down to Postgres — fine at
 * this data size (one row per workflow, small node arrays), and it's the
 * one place this scan lives, reused by both deleteConnection's precheck
 * and updateConnection's host/database-change warning.
 */
export async function listConnectionUsages(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  connectionId: string,
): Promise<{ workflows: ConnectionUsage[] }> {
  let workflowsQuery = supabase.from("workflows").select("id, name");
  workflowsQuery =
    "orgId" in scope ? workflowsQuery.eq("org_id", scope.orgId) : workflowsQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: workflows } = await workflowsQuery;
  if (!workflows || workflows.length === 0) return { workflows: [] };

  const workflowIds = workflows.map((w) => w.id as string);
  const { data: graphRows } = await supabase.from("workflow_graphs").select("workflow_id, graph").in("workflow_id", workflowIds);

  const usages: ConnectionUsage[] = [];
  for (const row of graphRows ?? []) {
    const parsed = GraphDoc.safeParse(row.graph);
    if (!parsed.success) continue;
    const matchingNodeIds = parsed.data.nodes.filter((n) => n.connectionId === connectionId).map((n) => n.id);
    if (matchingNodeIds.length === 0) continue;

    const { count: cleanPlanCount } = await supabase
      .from("clean_plans")
      .select("id", { count: "exact", head: true })
      .eq("workflow_id", row.workflow_id)
      .in("node_id", matchingNodeIds);

    const workflow = workflows.find((w) => w.id === row.workflow_id);
    usages.push({
      id: row.workflow_id as string,
      name: (workflow?.name as string | undefined) ?? "Untitled workflow",
      nodeCount: matchingNodeIds.length,
      cleanPlanCount: cleanPlanCount ?? 0,
    });
  }
  return { workflows: usages };
}

type ConnectionRowWithSecret = ConnectionRow & { vault_secret_ref: string };

/**
 * Full edit flow: config-only changes, credential rotation, or both, in
 * one call. Unlike createConnection (which requires every configSchema
 * field up front), edits are partial — splitFieldsForEdit never requires a
 * secret field, so leaving username/password blank means "keep what's
 * stored." Every save (even a display-name-only rename) round-trips
 * through dispatchTest against the connector before anything is persisted
 * — see the plan's step 5 for why this is unconditional rather than only
 * gated on config/credential changes.
 */
export async function updateConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
  input: { displayName?: string; fields?: Record<string, unknown>; confirmed?: boolean },
): Promise<Connection> {
  let existingQuery = supabase.from("connections").select(`${CONNECTIONS_SELECT}, vault_secret_ref`).eq("id", id);
  existingQuery = "orgId" in scope ? existingQuery.eq("org_id", scope.orgId) : existingQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data: existingRow } = await existingQuery.maybeSingle<ConnectionRowWithSecret>();
  if (!existingRow) throw new AppError(404, "NOT_FOUND", "Connection not found.");
  const existing = toConnection(existingRow);

  const manifest = getConnectorManifest(existing.connectorId);
  if (!manifest) throw new AppError(500, "UNKNOWN_CONNECTOR", `No manifest for connector "${existing.connectorId}".`);

  const { config: configPatch, secret: secretPatch } = splitFieldsForEdit(manifest.configSchema, input.fields ?? {});
  const mergedConfig = { ...existing.config, ...configPatch };
  const changedConfigKeys = Object.keys(configPatch).filter(
    (key) => JSON.stringify(configPatch[key]) !== JSON.stringify(existing.config[key]),
  );
  const displayNameChanged = input.displayName !== undefined && input.displayName !== existing.displayName;

  if ((changedConfigKeys.includes("host") || changedConfigKeys.includes("database")) && !input.confirmed) {
    const usages = await listConnectionUsages(supabase, scope, id);
    if (usages.workflows.length > 0) {
      throw new AppError(409, "USAGE_WARNING_REQUIRED", "This connection is used by other workflows.", usages);
    }
  }

  let newVaultRef: string | undefined;
  if (Object.keys(secretPatch).length > 0) {
    const { data: mergedRef, error: mergeError } = await supabase.rpc("merge_connector_secret", {
      p_old_ref: existingRow.vault_secret_ref,
      p_partial: secretPatch,
    });
    if (mergeError || !mergedRef) throw new AppError(500, "VAULT_WRITE_FAILED", mergeError?.message ?? "Failed to update credential.");
    newVaultRef = mergedRef as string;
  }

  const credential: CredentialRef = {
    connectionId: id,
    credVersion: existing.credVersion,
    vaultRef: newVaultRef ?? existingRow.vault_secret_ref,
  };
  const testResult = await dispatchTest(manifest, credential, mergedConfig);
  if (!testResult.ok) {
    if (newVaultRef) await supabase.rpc("delete_connector_secret", { p_ref: newVaultRef });
    throw new AppError(422, "TEST_FAILED", testResult.error ?? "Connection test failed.");
  }

  const patch: Record<string, unknown> = {};
  if (displayNameChanged) patch.display_name = input.displayName;
  const credentialsRotated = changedConfigKeys.length > 0 || Object.keys(secretPatch).length > 0;
  if (credentialsRotated) {
    patch.config = mergedConfig;
    patch.vault_secret_ref = newVaultRef ?? existingRow.vault_secret_ref;
    patch.cred_version = existing.credVersion + 1;
  }

  let updateQuery = supabase.from("connections").update(patch).eq("id", id);
  updateQuery = "orgId" in scope ? updateQuery.eq("org_id", scope.orgId) : updateQuery.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data, error } = await updateQuery.select(CONNECTIONS_SELECT).single();
  if (error) {
    // Same connections_scope_display_name_unique_idx collision as
    // createConnection (Item 6.1) — a renamed connection colliding with an
    // existing one in the same scope.
    if (error.code === "23505" && error.message.includes("connections_scope_display_name_unique_idx")) {
      throw new AppError(409, "NAME_TAKEN", `A connection named "${input.displayName}" already exists.`);
    }
    throw new AppError(500, "UPDATE_FAILED", error.message);
  }

  if (credentialsRotated) await dispatchInvalidate(manifest, id);

  const changedFields = [...changedConfigKeys, ...Object.keys(secretPatch), ...(displayNameChanged ? ["displayName"] : [])];
  if (changedFields.length > 0) {
    await supabase.rpc("log_connection_audit", {
      p_connection_id: id,
      p_action: "connection.updated",
      p_detail: { changedFields },
      p_actor_user_id: actorUserId,
    });
  }

  return toConnection(data as ConnectionRow);
}

/**
 * Delete-while-referenced is now guarded via listConnectionUsages (scans
 * workflow_graphs for nodes referencing this connectionId) rather than
 * left unimplemented — callers must pass confirmed: true once they've
 * shown the user the usage list to proceed anyway.
 */
export async function deleteConnection(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
  confirmed: boolean,
): Promise<void> {
  const existing = await getConnection(supabase, scope, id);
  if (!existing) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  if (!confirmed) {
    const usages = await listConnectionUsages(supabase, scope, id);
    if (usages.workflows.length > 0) {
      throw new AppError(409, "IN_USE", "This connection is used by other workflows.", usages);
    }
  }

  // Logged before the row is deleted — log_connection_audit looks up
  // org_id/owner_id from the connections row itself, same as
  // log_execution_audit, so it must run while the row still exists.
  await supabase.rpc("log_connection_audit", {
    p_connection_id: id,
    p_action: "connection.deleted",
    p_detail: { connectorId: existing.connectorId, handle: existing.handle },
    p_actor_user_id: actorUserId,
  });

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

/**
 * Serves the connector's introspected schema (entities/fields), used by the
 * canvas transform editor's field pickers (drop_fields multi-select,
 * computed_field/filter field references). RLS-scoped like every other
 * connections.ts function; cached (schemaCache.ts) so opening the editor
 * repeatedly doesn't re-hit the connector service on every drawer open.
 */
export async function getConnectionSchema(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
): Promise<IntrospectResponse> {
  let query = supabase
    .from("connections")
    .select("id, connector_id, config, vault_secret_ref, cred_version")
    .eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle<{
    id: string;
    connector_id: string;
    config: Record<string, unknown>;
    vault_secret_ref: string;
    cred_version: number;
  }>();
  if (!data) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const manifest = getConnectorManifest(data.connector_id);
  if (!manifest) throw new AppError(500, "UNKNOWN_CONNECTOR", `No manifest for connector "${data.connector_id}".`);

  const credential: CredentialRef = {
    connectionId: data.id,
    credVersion: data.cred_version,
    vaultRef: data.vault_secret_ref,
  };

  const cached = getCachedSchema(credential);
  if (cached) return cached;

  const result = await dispatchIntrospect(manifest, credential, data.config);
  if (!result.ok) throw new AppError(502, "INTROSPECT_FAILED", result.error);

  setCachedSchema(credential, result.value);
  return result.value;
}

/**
 * Phase 5 Session 5, Block 2 — "Refresh schema" affordance's service
 * function. Busts THIS process's cached entry immediately (so the next
 * getConnectionSchema call — e.g. the destination drawer's field pickers —
 * never serves stale data even if the round trip below fails), then
 * enqueues a schema_refresh job so the WORKER's separate introspection
 * cache (lib/introspection.ts, used by every check_run's mappings check —
 * see runWorkflowChecks.ts's buildMappingsCheck) is busted and re-warmed
 * too. Both caches are keyed identically (connectionId:credVersion) but
 * live in different processes with no shared memory, so both halves must
 * be cleared explicitly for a single click to make "Run checks"
 * immediately see live (post-drift) field names.
 */
export async function refreshConnectionSchema(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  triggeredByUserId: string,
): Promise<IntrospectResponse> {
  let query = supabase
    .from("connections")
    .select("id, connector_id, config, vault_secret_ref, cred_version")
    .eq("id", id);
  query = "orgId" in scope ? query.eq("org_id", scope.orgId) : query.is("org_id", null).eq("owner_id", scope.ownerId);
  const { data } = await query.maybeSingle<{
    id: string;
    connector_id: string;
    config: Record<string, unknown>;
    vault_secret_ref: string;
    cred_version: number;
  }>();
  if (!data) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const credential: CredentialRef = {
    connectionId: data.id,
    credVersion: data.cred_version,
    vaultRef: data.vault_secret_ref,
  };
  invalidateCachedSchema(credential);

  const schema = await runSchemaRefreshJob({ scope, connectionId: id, triggeredByUserId });

  setCachedSchema(credential, schema);

  await supabase.rpc("log_connection_audit", {
    p_connection_id: id,
    p_action: "connection.schema_refreshed",
    p_detail: {},
    p_actor_user_id: triggeredByUserId,
  });

  return schema;
}

const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type SourceProfileRow = {
  schema_hash: string;
  sample_method: string;
  sample_size: number;
  stats: unknown;
  signature: unknown;
  profile_hash: string;
  profiled_at: string;
};

/** Hashes an entity's (name, type) field list — the source_profiles cache key that detects "the source schema changed" (see 0020_source_profiles.sql's header comment). Sorted by name so field reordering in the connector's own introspect response never spuriously busts the cache. */
function computeSchemaHash(entity: { fields: { name: string; type: string }[] }): string {
  const canonical = [...entity.fields].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ name: f.name, type: f.type }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function rowToProfile(row: SourceProfileRow): EntityProfile {
  return EntityProfile.parse({
    sampleMethod: row.sample_method,
    sampleSize: row.sample_size,
    columns: row.stats,
    signature: row.signature,
    profileHash: row.profile_hash,
    profiledAt: row.profiled_at,
  });
}

function findSchemaEntity(schema: IntrospectResponse, entity: EntityRef): IntrospectResponse["entities"][number] {
  const found = schema.entities.find((e) => e.namespace === entity.namespace && e.name === entity.name);
  if (!found) throw new AppError(404, "ENTITY_NOT_FOUND", `Entity ${entity.namespace}.${entity.name} not found in this connection's schema.`);
  return found;
}

/**
 * Phase 10 — Profile tab's read path. Reuses the cached source_profiles
 * row when its schema_hash still matches the entity's CURRENT introspected
 * schema (computeSchemaHash below, same hash algorithm the cache row was
 * written with) and profiled_at is under 24h old; otherwise falls through
 * to refreshConnectionProfile, same "stale cache -> re-fetch" shape as
 * getConnectionSchema/schemaCache.ts, just backed by a real table instead
 * of an in-process Map (profiles are per-entity and too numerous/large to
 * keep only in memory).
 */
export async function getConnectionProfile(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  entity: EntityRef,
  triggeredByUserId: string,
): Promise<EntityProfile> {
  const schema = await getConnectionSchema(supabase, scope, id);
  const schemaHash = computeSchemaHash(findSchemaEntity(schema, entity));

  const { data } = await supabase
    .from("source_profiles")
    .select("schema_hash, sample_method, sample_size, stats, signature, profile_hash, profiled_at")
    .eq("connection_id", id)
    .eq("entity_namespace", entity.namespace)
    .eq("entity_name", entity.name)
    .maybeSingle<SourceProfileRow>();

  if (data && data.schema_hash === schemaHash && Date.now() - new Date(data.profiled_at).getTime() < PROFILE_CACHE_TTL_MS) {
    return rowToProfile(data);
  }

  return refreshConnectionProfile(supabase, scope, id, entity, triggeredByUserId);
}

/**
 * Manual "Refresh" affordance, and getConnectionProfile's fallback on a
 * stale/missing cache row. Runs the worker's profile_run job (bounded, see
 * profileQueue.ts's header comment) then upserts the result into
 * source_profiles keyed on (connection_id, entity_namespace, entity_name)
 * — the unique constraint 0020_source_profiles.sql defines specifically so
 * this can be a real upsert, not a delete+insert.
 */
export async function refreshConnectionProfile(
  supabase: SupabaseClient,
  scope: WorkspaceScope,
  id: string,
  entity: EntityRef,
  triggeredByUserId: string,
): Promise<EntityProfile> {
  const schema = await getConnectionSchema(supabase, scope, id);
  const schemaHash = computeSchemaHash(findSchemaEntity(schema, entity));

  const profile = await runProfileJob({ scope, connectionId: id, entity, triggeredByUserId });

  const { error } = await supabase.from("source_profiles").upsert(
    {
      connection_id: id,
      entity_namespace: entity.namespace,
      entity_name: entity.name,
      schema_hash: schemaHash,
      sample_method: profile.sampleMethod,
      sample_size: profile.sampleSize,
      stats: profile.columns,
      signature: profile.signature,
      profile_hash: profile.profileHash,
      profiled_at: profile.profiledAt,
      profiled_by_user_id: triggeredByUserId,
    },
    { onConflict: "connection_id,entity_namespace,entity_name" },
  );
  if (error) throw new AppError(500, "PROFILE_UPSERT_FAILED", error.message);

  return profile;
}
