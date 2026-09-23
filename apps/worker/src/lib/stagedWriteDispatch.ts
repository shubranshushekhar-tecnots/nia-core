import type {
  AssertionSpec,
  CreateColumnSpec,
  CreateEntityKind,
  CreateEntityRequest,
  CreateEntityResponse,
  DropEntityRequest,
  DropEntityResponse,
  PreflightRequest,
  PreflightResponse,
  StageOp,
  StageRequest,
  StageResponse,
  WriteContext,
  WriteEntityRef,
  WriteMode,
} from "@nia/schemas";
import { resolveConnection, type ResolvedConnection } from "./resolveConnection.js";
import { resolveWriteGrant } from "./resolveWriteGrant.js";
import {
  sendStageRequest,
  sendPreflightRequest,
  sendCreateEntityRequest,
  sendDropEntityRequest,
} from "./connectorClient.js";
import { signWriteContext } from "./writeSignature.js";
import { logExecutionAudit } from "./executionAudit.js";
import { env } from "../env.js";
import type { WorkspaceScope } from "./workspaceScope.js";
import type { DispatchResult } from "./errors.js";

/**
 * Phase 11 Block 2A/2B/2D — the staging-lifecycle counterpart to
 * writeDispatch.ts's `dispatchWrite`. Two entry points:
 *
 *   - `dispatchStage` — one signed StageRequest per lifecycle op (create/
 *     apply/drop), following the exact same resolveConnection ->
 *     resolveWriteGrant -> sign -> send -> audit shape as dispatchWrite.
 *     The grant check is against `input.entity.namespace` (the
 *     DESTINATION's real namespace), never "nia" — /stage ops reuse the
 *     existing destination write grant, since the connector's own /stage
 *     handler re-checks the grant the same way (see connector-supabase's
 *     index.ts). This is different from a per-chunk staging row upsert
 *     (still routed through plain dispatchWrite with `entity: stagingEntity`
 *     — see runEtl.ts), which DOES need "nia" in the grant's schema scope.
 *
 *   - `dispatchPreflight` — unsigned, read-only, no grant resolution (the
 *     connector's /preflight handler opens a pool straight from the
 *     credential and inspects role privileges itself; there is no mutation
 *     for a grant to gate).
 */
export type StageDispatchInput = {
  op: StageOp;
  /** Destination entity — the real table/collection this run writes to. */
  entity: WriteEntityRef;
  /** Full mapped destination column list — same convention as WriteDispatchInput.columns; only consulted by `apply` (builds the INSERT ... SELECT column list). */
  columns: string[];
  stagingEntity: WriteEntityRef;
  quarantineEntity: WriteEntityRef | null;
  runId: string;
  mode: WriteMode;
  upsertKeys: string[];
  /** Only consulted by `apply`; ignored by `create`/`drop`. */
  assertions?: AssertionSpec[];
  timeoutMs?: number;
};

export async function dispatchStage(
  connectionId: string,
  input: StageDispatchInput,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<StageResponse>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const grant = await resolveWriteGrant(connection.id, input.entity.namespace);
  if (!grant.ok) {
    await auditStage(connection, actorUserId, input, `rejected: ${grant.error.message}`);
    return grant;
  }

  const issuedAt = Date.now();
  const signature = signWriteContext(
    {
      connectionId: connection.id,
      grantId: grant.value.grantId,
      runId: input.runId,
      entity: input.entity,
      grantNamespace: input.entity.namespace,
      columns: input.columns,
      mode: input.mode,
      stagingEntity: input.stagingEntity,
      quarantineEntity: input.quarantineEntity,
      issuedAt,
    },
    env.WRITE_DISPATCH_SIGNING_SECRET,
  );
  const context: WriteContext = {
    connectionId: connection.id,
    grantId: grant.value.grantId,
    runId: input.runId,
    entity: input.entity,
    grantNamespace: input.entity.namespace,
    columns: input.columns,
    mode: input.mode,
    stagingEntity: input.stagingEntity,
    quarantineEntity: input.quarantineEntity,
    issuedAt,
    signature,
  };

  const request: StageRequest = {
    credential: { connectionId: connection.id, credVersion: grant.value.credVersion, vaultRef: grant.value.vaultRef },
    config: connection.config,
    op: input.op,
    entity: input.entity,
    stagingEntity: input.stagingEntity,
    quarantineEntity: input.quarantineEntity,
    runId: input.runId,
    mode: input.mode,
    upsertKeys: input.upsertKeys,
    assertions: input.assertions ?? [],
    timeoutMs: input.timeoutMs ?? 30000,
    context,
  };

  const result = await sendStageRequest(connection.manifest, request, { timeoutMs: input.timeoutMs });
  await auditStage(
    connection,
    actorUserId,
    input,
    result.ok ? `${input.op} ok${result.value.applied !== undefined ? ` (applied ${result.value.applied})` : ""}` : result.error.message,
  );
  return result;
}

async function auditStage(
  connection: ResolvedConnection,
  actorUserId: string,
  input: StageDispatchInput,
  outcome: string,
): Promise<void> {
  await logExecutionAudit({
    connectionId: connection.id,
    connectionOwnerUserId: connection.ownerUserId,
    connectorId: connection.connectorId,
    handle: connection.handle,
    operation: `stage:${input.op}`,
    query: `STAGE ${input.op.toUpperCase()} run=${input.runId} staging=${input.stagingEntity.namespace}.${input.stagingEntity.name} -> ${input.entity.namespace}.${input.entity.name} -> ${outcome}`,
    actorUserId,
  });
}

export type PreflightDispatchInput = {
  entity: WriteEntityRef;
  upsertKeys: string[];
};

/**
 * Read-only, unsigned — see this file's header comment. Called once before
 * extraction starts a staged run (job.cursor === null), so a missing
 * privilege fails fast with an actionable message instead of partway
 * through staging DDL.
 *
 * Still resolves the confirmed write grant (same lookup dispatchStage uses)
 * purely to get its credential: preflight is checking whether the WRITE
 * role can create/drop in "nia" and INSERT into the destination, so it must
 * open its probe pool with the write credential, not `connection.credential`
 * (the connection's own read-only vault ref) — using the read credential
 * would silently check the wrong role's privileges. No grant-validity
 * mutation happens here, so "no grant resolution" in this function's
 * original design note only ever meant "no signing/audit," not "no grant
 * lookup at all."
 */
export async function dispatchPreflight(
  connectionId: string,
  input: PreflightDispatchInput,
  scope: WorkspaceScope,
): Promise<DispatchResult<PreflightResponse>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const grant = await resolveWriteGrant(connection.id, input.entity.namespace);
  if (!grant.ok) return grant;

  const request: PreflightRequest = {
    credential: { connectionId: connection.id, credVersion: grant.value.credVersion, vaultRef: grant.value.vaultRef },
    config: connection.config,
    entity: input.entity,
    upsertKeys: input.upsertKeys,
  };
  return sendPreflightRequest(connection.manifest, request);
}

/**
 * Schema layer, Part 4 — destination creation. Same resolveConnection ->
 * resolveWriteGrant -> sign -> send -> audit shape as `dispatchStage`, and
 * reuses WriteContext/signWriteContext for the signed binding rather than
 * a new signed-payload shape (see contract.ts's CreateEntityRequest doc
 * comment): `columns` in the signed context is just the create-entity
 * column names, `stagingEntity`/`quarantineEntity` are null (a create-
 * entity call never touches staging), `mode` is the schema default
 * ("upsert" — unused by /create-entity but required by WriteContext's
 * shape). Grant check is against `input.entity.namespace`, the real
 * destination namespace, same as dispatchStage.
 */
export type CreateEntityDispatchInput = {
  kind: CreateEntityKind;
  entity: WriteEntityRef;
  columns: CreateColumnSpec[];
  keys: string[];
  runId: string;
  timeoutMs?: number;
};

export async function dispatchCreateEntity(
  connectionId: string,
  input: CreateEntityDispatchInput,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<CreateEntityResponse>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const grant = await resolveWriteGrant(connection.id, input.entity.namespace);
  if (!grant.ok) {
    await auditCreateEntity(connection, actorUserId, input, `rejected: ${grant.error.message}`);
    return grant;
  }

  const columnNames = input.columns.map((c) => c.name);
  const issuedAt = Date.now();
  const signature = signWriteContext(
    {
      connectionId: connection.id,
      grantId: grant.value.grantId,
      runId: input.runId,
      entity: input.entity,
      grantNamespace: input.entity.namespace,
      columns: columnNames,
      mode: "upsert",
      stagingEntity: null,
      quarantineEntity: null,
      issuedAt,
    },
    env.WRITE_DISPATCH_SIGNING_SECRET,
  );
  const context: WriteContext = {
    connectionId: connection.id,
    grantId: grant.value.grantId,
    runId: input.runId,
    entity: input.entity,
    grantNamespace: input.entity.namespace,
    columns: columnNames,
    mode: "upsert",
    stagingEntity: null,
    quarantineEntity: null,
    issuedAt,
    signature,
  };

  const request: CreateEntityRequest = {
    credential: { connectionId: connection.id, credVersion: grant.value.credVersion, vaultRef: grant.value.vaultRef },
    config: connection.config,
    kind: input.kind,
    entity: input.entity,
    columns: input.columns,
    keys: input.keys,
    timeoutMs: input.timeoutMs ?? 30000,
    context,
  };

  const result = await sendCreateEntityRequest(connection.manifest, request, { timeoutMs: input.timeoutMs });
  await auditCreateEntity(
    connection,
    actorUserId,
    input,
    result.ok ? `created=${result.value.created}` : result.error.message,
  );
  return result;
}

async function auditCreateEntity(
  connection: ResolvedConnection,
  actorUserId: string,
  input: CreateEntityDispatchInput,
  outcome: string,
): Promise<void> {
  await logExecutionAudit({
    connectionId: connection.id,
    connectionOwnerUserId: connection.ownerUserId,
    connectorId: connection.connectorId,
    handle: connection.handle,
    operation: "create-entity",
    query: `CREATE ${input.kind.toUpperCase()} run=${input.runId} ${input.entity.namespace}.${input.entity.name} -> ${outcome}`,
    actorUserId,
  });
}

/**
 * Orphaned-destination-table lifecycle fix — the drop-side counterpart to
 * `dispatchCreateEntity`. Only ever called by runEtl.ts's failStaged
 * against an entity the worker's own stagingRegistry recorded THIS run as
 * having created (see stagingRegistry.ts's registerDestinationObject) —
 * never a general "drop any table" capability. Same
 * resolveConnection -> resolveWriteGrant -> sign -> send -> audit shape as
 * dispatchCreateEntity.
 */
export type DropEntityDispatchInput = {
  kind: CreateEntityKind;
  entity: WriteEntityRef;
  /** The entity's column names at create time (registry-recorded) — WriteContext.columns requires at least one entry; not otherwise consulted by a drop. */
  columns: string[];
  runId: string;
  timeoutMs?: number;
};

export async function dispatchDropEntity(
  connectionId: string,
  input: DropEntityDispatchInput,
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<DispatchResult<DropEntityResponse>> {
  const resolved = await resolveConnection(connectionId, scope);
  if (!resolved.ok) return resolved;
  const connection = resolved.value;

  const grant = await resolveWriteGrant(connection.id, input.entity.namespace);
  if (!grant.ok) {
    await auditDropEntity(connection, actorUserId, input, `rejected: ${grant.error.message}`);
    return grant;
  }

  const issuedAt = Date.now();
  const signature = signWriteContext(
    {
      connectionId: connection.id,
      grantId: grant.value.grantId,
      runId: input.runId,
      entity: input.entity,
      grantNamespace: input.entity.namespace,
      columns: input.columns,
      mode: "upsert",
      stagingEntity: null,
      quarantineEntity: null,
      issuedAt,
    },
    env.WRITE_DISPATCH_SIGNING_SECRET,
  );
  const context: WriteContext = {
    connectionId: connection.id,
    grantId: grant.value.grantId,
    runId: input.runId,
    entity: input.entity,
    grantNamespace: input.entity.namespace,
    columns: input.columns,
    mode: "upsert",
    stagingEntity: null,
    quarantineEntity: null,
    issuedAt,
    signature,
  };

  const request: DropEntityRequest = {
    credential: { connectionId: connection.id, credVersion: grant.value.credVersion, vaultRef: grant.value.vaultRef },
    config: connection.config,
    kind: input.kind,
    entity: input.entity,
    timeoutMs: input.timeoutMs ?? 30000,
    context,
  };

  const result = await sendDropEntityRequest(connection.manifest, request, { timeoutMs: input.timeoutMs });
  await auditDropEntity(
    connection,
    actorUserId,
    input,
    result.ok ? `dropped=${result.value.dropped}` : result.error.message,
  );
  return result;
}

async function auditDropEntity(
  connection: ResolvedConnection,
  actorUserId: string,
  input: DropEntityDispatchInput,
  outcome: string,
): Promise<void> {
  await logExecutionAudit({
    connectionId: connection.id,
    connectionOwnerUserId: connection.ownerUserId,
    connectorId: connection.connectorId,
    handle: connection.handle,
    operation: "drop-entity",
    query: `DROP ${input.kind.toUpperCase()} run=${input.runId} ${input.entity.namespace}.${input.entity.name} -> ${outcome}`,
    actorUserId,
  });
}
