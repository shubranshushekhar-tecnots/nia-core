import { createHash } from "node:crypto";
import { workspaceWhere } from "@nia/db";
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
import { getSecretStore, toSecretScope } from "../lib/secretStore.js";
import { getCachedSchema, setCachedSchema, invalidateCachedSchema } from "../lib/schemaCache.js";
import { runSchemaRefreshJob } from "../lib/schemaRefreshQueue.js";
import { runProfileJob } from "../lib/profileQueue.js";
import type { WithUser } from "../lib/withUser.js";

function isUniqueViolation(err: unknown): err is { code: string; message: string } {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

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

export async function listConnections(withUser: WithUser, scope: WorkspaceScope): Promise<Connection[]> {
  const where = workspaceWhere(scope, 1);
  const { rows } = await withUser((db) =>
    db.query<ConnectionRow>(
      `select ${CONNECTIONS_SELECT} from connections where ${where.sql} order by created_at desc`,
      where.params,
    ),
  );
  return rows.map(toConnection);
}

export async function getConnection(withUser: WithUser, scope: WorkspaceScope, id: string): Promise<Connection | null> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<ConnectionRow>(`select ${CONNECTIONS_SELECT} from connections where id = $1 and ${where.sql}`, [id, ...where.params]),
  );
  return rows[0] ? toConnection(rows[0]) : null;
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
  withUser: WithUser,
  scope: WorkspaceScope,
  ownerUserId: string,
  input: { connectorId: string; displayName: string; fields: Record<string, unknown> },
): Promise<Connection> {
  const manifest = getConnectorManifest(input.connectorId);
  if (!manifest) throw new AppError(400, "UNKNOWN_CONNECTOR", `No manifest for connector "${input.connectorId}".`);

  // Guard: install-before-connect. No FK enforces this (connector_id is a
  // free-text slug, not a foreign key — manifests are files, not rows), so
  // this is a route-level check, not RLS.
  const installWhere = workspaceWhere(scope, 2);
  const { rows: installRows } = await withUser((db) =>
    db.query<{ count: number }>(
      `select count(*)::int as count from connector_installs where connector_id = $1 and ${installWhere.sql}`,
      [input.connectorId, ...installWhere.params],
    ),
  );
  if (!installRows[0]?.count) {
    throw new AppError(409, "NOT_INSTALLED", `"${input.connectorId}" must be installed before connecting.`);
  }

  const { config, secret } = splitFields(manifest.configSchema, input.fields);

  const vaultRef = await getSecretStore(withUser).put(secret, toSecretScope(scope));

  const orgId = "orgId" in scope ? scope.orgId : null;
  const ownerId = "orgId" in scope ? null : scope.ownerId;

  const base = `@${manifest.id}-${slugify(input.displayName)}`;
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
    const handle = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const { rows } = await withUser((db) =>
        db.query<ConnectionRow>(
          `insert into connections (org_id, owner_id, connector_id, handle, display_name, owner_user_id, config, vault_secret_ref)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning ${CONNECTIONS_SELECT}`,
          [orgId, ownerId, manifest.id, handle, input.displayName, ownerUserId, config, vaultRef as string],
        ),
      );
      return toConnection(rows[0]!);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AppError(500, "CREATE_FAILED", message);
      }
      // Two distinct unique constraints can raise 23505 here: the handle
      // uniqueness this retry loop is built to work around, and
      // connections_scope_display_name_unique_idx (0029, Item 6.1) on
      // display_name — a display_name collision won't go away by retrying
      // with a new handle suffix (display_name doesn't change across
      // attempts), so it must be surfaced immediately rather than exhausting
      // every attempt only to report the wrong error (HANDLE_EXHAUSTED).
      if (err.message.includes("connections_scope_display_name_unique_idx")) {
        throw new AppError(409, "NAME_TAKEN", `A connection named "${input.displayName}" already exists.`);
      }
      // Unique violation on handle — try the next suffix.
    }
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
  withUser: WithUser,
  scope: WorkspaceScope,
  connectionId: string,
): Promise<{ workflows: ConnectionUsage[] }> {
  const workflowsWhere = workspaceWhere(scope, 1);
  const { rows: workflows } = await withUser((db) =>
    db.query<{ id: string; name: string }>(`select id, name from workflows where ${workflowsWhere.sql}`, workflowsWhere.params),
  );
  if (workflows.length === 0) return { workflows: [] };

  const workflowIds = workflows.map((w) => w.id);
  const { rows: graphRows } = await withUser((db) =>
    db.query<{ workflow_id: string; graph: unknown }>(
      `select workflow_id, graph from workflow_graphs where workflow_id = any($1::uuid[])`,
      [workflowIds],
    ),
  );

  const usages: ConnectionUsage[] = [];
  for (const row of graphRows) {
    const parsed = GraphDoc.safeParse(row.graph);
    if (!parsed.success) continue;
    const matchingNodeIds = parsed.data.nodes.filter((n) => n.connectionId === connectionId).map((n) => n.id);
    if (matchingNodeIds.length === 0) continue;

    const { rows: cleanPlanRows } = await withUser((db) =>
      db.query<{ count: number }>(
        `select count(*)::int as count from clean_plans where workflow_id = $1 and node_id = any($2::text[])`,
        [row.workflow_id, matchingNodeIds],
      ),
    );

    const workflow = workflows.find((w) => w.id === row.workflow_id);
    usages.push({
      id: row.workflow_id,
      name: workflow?.name ?? "Untitled workflow",
      nodeCount: matchingNodeIds.length,
      cleanPlanCount: cleanPlanRows[0]?.count ?? 0,
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
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
  input: { displayName?: string; fields?: Record<string, unknown>; confirmed?: boolean },
): Promise<Connection> {
  const existingWhere = workspaceWhere(scope, 2);
  const { rows: existingRows } = await withUser((db) =>
    db.query<ConnectionRowWithSecret>(
      `select ${CONNECTIONS_SELECT}, vault_secret_ref from connections where id = $1 and ${existingWhere.sql}`,
      [id, ...existingWhere.params],
    ),
  );
  const existingRow = existingRows[0];
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
    const usages = await listConnectionUsages(withUser, scope, id);
    if (usages.workflows.length > 0) {
      throw new AppError(409, "USAGE_WARNING_REQUIRED", "This connection is used by other workflows.", usages);
    }
  }

  // Merge moved into the API (docs/plans/secret-storage.md's update-path
  // report): the master key that would decrypt an existing secret never
  // reaches Postgres, so unlike the old merge_connector_secret RPC, the
  // decrypt + merge + re-encrypt all happen here in TypeScript via
  // SecretStore. get() transparently falls back to
  // decrypt_connector_secret_for_edit for a ref that predates nia_secrets.
  let newVaultRef: string | undefined;
  if (Object.keys(secretPatch).length > 0) {
    const secretStore = getSecretStore(withUser);
    const existingSecret = await secretStore.get(existingRow.vault_secret_ref);
    if (!existingSecret) {
      throw new AppError(500, "VAULT_READ_FAILED", `Secret not found for ref ${existingRow.vault_secret_ref}.`);
    }
    const merged = { ...existingSecret, ...secretPatch };
    newVaultRef = await secretStore.put(merged, toSecretScope(scope));
  }

  const credential: CredentialRef = {
    connectionId: id,
    credVersion: existing.credVersion,
    vaultRef: newVaultRef ?? existingRow.vault_secret_ref,
  };
  const testResult = await dispatchTest(manifest, credential, mergedConfig);
  if (!testResult.ok) {
    if (newVaultRef) await getSecretStore(withUser).delete(newVaultRef);
    throw new AppError(
      422,
      "TEST_FAILED",
      testResult.error?.message ?? "Connection test failed.",
      testResult.error?.details,
    );
  }

  const credentialsRotated = changedConfigKeys.length > 0 || Object.keys(secretPatch).length > 0;

  const setClauses: string[] = [];
  const setParams: unknown[] = [];
  if (displayNameChanged) {
    setParams.push(input.displayName);
    setClauses.push(`display_name = $${setParams.length}`);
  }
  if (credentialsRotated) {
    setParams.push(mergedConfig);
    setClauses.push(`config = $${setParams.length}`);
    setParams.push(newVaultRef ?? existingRow.vault_secret_ref);
    setClauses.push(`vault_secret_ref = $${setParams.length}`);
    setParams.push(existing.credVersion + 1);
    setClauses.push(`cred_version = $${setParams.length}`);
  }

  let updatedRow: ConnectionRow;
  if (setClauses.length === 0) {
    // Nothing actually changed (a no-op save) — PostgREST's `.update({})`
    // has no real column list to write either; the visible outcome is the
    // same unchanged row, so just re-read it rather than issue an empty SQL SET.
    updatedRow = existingRow;
  } else {
    setParams.push(id);
    const idParamIndex = setParams.length;
    const scopeWhere = workspaceWhere(scope, setParams.length + 1);
    try {
      const { rows } = await withUser((db) =>
        db.query<ConnectionRow>(
          `update connections set ${setClauses.join(", ")}
           where id = $${idParamIndex} and ${scopeWhere.sql}
           returning ${CONNECTIONS_SELECT}`,
          [...setParams, ...scopeWhere.params],
        ),
      );
      updatedRow = rows[0]!;
    } catch (err) {
      // Same connections_scope_display_name_unique_idx collision as
      // createConnection (Item 6.1) — a renamed connection colliding with an
      // existing one in the same scope.
      if (isUniqueViolation(err) && err.message.includes("connections_scope_display_name_unique_idx")) {
        throw new AppError(409, "NAME_TAKEN", `A connection named "${input.displayName}" already exists.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(500, "UPDATE_FAILED", message);
    }
  }

  if (credentialsRotated) await dispatchInvalidate(manifest, id);

  const changedFields = [...changedConfigKeys, ...Object.keys(secretPatch), ...(displayNameChanged ? ["displayName"] : [])];
  if (changedFields.length > 0) {
    await withUser((db) =>
      db.query(`select public.log_connection_audit($1, $2, $3, $4)`, [
        id,
        "connection.updated",
        { changedFields },
        actorUserId,
      ]),
    );
  }

  return toConnection(updatedRow);
}

/**
 * Delete-while-referenced is now guarded via listConnectionUsages (scans
 * workflow_graphs for nodes referencing this connectionId) rather than
 * left unimplemented — callers must pass confirmed: true once they've
 * shown the user the usage list to proceed anyway.
 */
export async function deleteConnection(
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
  confirmed: boolean,
): Promise<void> {
  const existing = await getConnection(withUser, scope, id);
  if (!existing) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  if (!confirmed) {
    const usages = await listConnectionUsages(withUser, scope, id);
    if (usages.workflows.length > 0) {
      throw new AppError(409, "IN_USE", "This connection is used by other workflows.", usages);
    }
  }

  // Logged before the row is deleted — log_connection_audit looks up
  // org_id/owner_id from the connections row itself, same as
  // log_execution_audit, so it must run while the row still exists.
  await withUser((db) =>
    db.query(`select public.log_connection_audit($1, $2, $3, $4)`, [
      id,
      "connection.deleted",
      { connectorId: existing.connectorId, handle: existing.handle },
      actorUserId,
    ]),
  );

  const deleteWhere = workspaceWhere(scope, 2);
  try {
    await withUser((db) => db.query(`delete from connections where id = $1 and ${deleteWhere.sql}`, [id, ...deleteWhere.params]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "DELETE_FAILED", message);
  }

  const manifest = getConnectorManifest(existing.connectorId);
  if (manifest) await dispatchInvalidate(manifest, id);
}

export async function testConnection(
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  actorUserId: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string; details?: string }> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<{
      id: string;
      connector_id: string;
      handle: string;
      config: Record<string, unknown>;
      vault_secret_ref: string;
      cred_version: number;
      owner_user_id: string;
    }>(
      `select id, connector_id, handle, config, vault_secret_ref, cred_version, owner_user_id
       from connections where id = $1 and ${where.sql}`,
      [id, ...where.params],
    ),
  );
  const data = rows[0];
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
  await logExecutionAudit(withUser, {
    connectionId: data.id,
    connectionOwnerUserId: data.owner_user_id,
    connectorId: data.connector_id,
    handle: data.handle,
    operation: "test",
    query: "SELECT 1",
    actorUserId,
  });

  await withUser((db) =>
    db.query(`update connections set last_test_status = $1, last_test_latency_ms = $2, last_test_at = $3 where id = $4`, [
      result.ok ? "ok" : "error",
      result.latencyMs ?? null,
      new Date().toISOString(),
      id,
    ]),
  );

  return { ok: result.ok, latencyMs: result.latencyMs, error: result.error?.message, details: result.error?.details };
}

/**
 * Serves the connector's introspected schema (entities/fields), used by the
 * canvas transform editor's field pickers (drop_fields multi-select,
 * computed_field/filter field references). RLS-scoped like every other
 * connections.ts function; cached (schemaCache.ts) so opening the editor
 * repeatedly doesn't re-hit the connector service on every drawer open.
 */
export async function getConnectionSchema(withUser: WithUser, scope: WorkspaceScope, id: string): Promise<IntrospectResponse> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<{
      id: string;
      connector_id: string;
      config: Record<string, unknown>;
      vault_secret_ref: string;
      cred_version: number;
    }>(`select id, connector_id, config, vault_secret_ref, cred_version from connections where id = $1 and ${where.sql}`, [
      id,
      ...where.params,
    ]),
  );
  const data = rows[0];
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
  if (!result.ok) throw new AppError(502, "INTROSPECT_FAILED", result.error.message, result.error.details);

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
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  triggeredByUserId: string,
): Promise<IntrospectResponse> {
  const where = workspaceWhere(scope, 2);
  const { rows } = await withUser((db) =>
    db.query<{
      id: string;
      connector_id: string;
      config: Record<string, unknown>;
      vault_secret_ref: string;
      cred_version: number;
    }>(`select id, connector_id, config, vault_secret_ref, cred_version from connections where id = $1 and ${where.sql}`, [
      id,
      ...where.params,
    ]),
  );
  const data = rows[0];
  if (!data) throw new AppError(404, "NOT_FOUND", "Connection not found.");

  const credential: CredentialRef = {
    connectionId: data.id,
    credVersion: data.cred_version,
    vaultRef: data.vault_secret_ref,
  };
  invalidateCachedSchema(credential);

  const schema = await runSchemaRefreshJob({ scope, connectionId: id, triggeredByUserId });

  setCachedSchema(credential, schema);

  await withUser((db) =>
    db.query(`select public.log_connection_audit($1, $2, $3, $4)`, [
      id,
      "connection.schema_refreshed",
      {},
      triggeredByUserId,
    ]),
  );

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
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  entity: EntityRef,
  triggeredByUserId: string,
): Promise<EntityProfile> {
  const schema = await getConnectionSchema(withUser, scope, id);
  const schemaHash = computeSchemaHash(findSchemaEntity(schema, entity));

  const { rows } = await withUser((db) =>
    db.query<SourceProfileRow>(
      `select schema_hash, sample_method, sample_size, stats, signature, profile_hash, profiled_at
       from source_profiles where connection_id = $1 and entity_namespace = $2 and entity_name = $3`,
      [id, entity.namespace, entity.name],
    ),
  );
  const data = rows[0];

  if (data && data.schema_hash === schemaHash && Date.now() - new Date(data.profiled_at).getTime() < PROFILE_CACHE_TTL_MS) {
    return rowToProfile(data);
  }

  return refreshConnectionProfile(withUser, scope, id, entity, triggeredByUserId);
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
  withUser: WithUser,
  scope: WorkspaceScope,
  id: string,
  entity: EntityRef,
  triggeredByUserId: string,
): Promise<EntityProfile> {
  const schema = await getConnectionSchema(withUser, scope, id);
  const schemaHash = computeSchemaHash(findSchemaEntity(schema, entity));

  const profile = await runProfileJob({ scope, connectionId: id, entity, triggeredByUserId });

  try {
    await withUser((db) =>
      db.query(
        `insert into source_profiles
           (connection_id, entity_namespace, entity_name, schema_hash, sample_method, sample_size, stats, signature, profile_hash, profiled_at, profiled_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (connection_id, entity_namespace, entity_name)
         do update set
           schema_hash = excluded.schema_hash,
           sample_method = excluded.sample_method,
           sample_size = excluded.sample_size,
           stats = excluded.stats,
           signature = excluded.signature,
           profile_hash = excluded.profile_hash,
           profiled_at = excluded.profiled_at,
           profiled_by_user_id = excluded.profiled_by_user_id`,
        [
          id,
          entity.namespace,
          entity.name,
          schemaHash,
          profile.sampleMethod,
          profile.sampleSize,
          profile.columns,
          profile.signature,
          profile.profileHash,
          profile.profiledAt,
          triggeredByUserId,
        ],
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppError(500, "PROFILE_UPSERT_FAILED", message);
  }

  return profile;
}
