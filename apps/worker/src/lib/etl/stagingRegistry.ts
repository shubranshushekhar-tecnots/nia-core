import { createHash } from "node:crypto";
import type { WriteEntityRef } from "@nia/schemas";
import { withServiceRole } from "@nia/db";
import { dbPool } from "../dbPool.js";

/**
 * Phase 11 — worker-side bookkeeping for the staging lifecycle
 * (0021_staging_registry.sql). This is a SECOND, independent layer, not the
 * primary enforcement point — a connector's own signed-WriteContext
 * verification (index.ts's /stage handler) is what actually refuses to
 * CREATE/DROP/apply against a name it wasn't told to use. This module only
 * lets the worker (a) recompute the same staging table name on a resumed
 * run without re-reading anything back, and (b) know which names to sweep
 * once they're stale.
 */

const STAGING_NAMESPACE = "nia";
const QUARANTINE_TABLE_NAME = "nia_quarantine";

/**
 * Deterministic per-run staging table name — a resumed run's chunk loop
 * recomputes the exact same name from `runId` alone, no round-trip needed.
 * `workflow_runs.staging_table` is still persisted (persistStagingTable
 * below) purely for operator visibility/debugging, per that column's
 * migration comment — nothing in the run path actually reads it back.
 */
export function deriveStagingEntity(runId: string): WriteEntityRef {
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  return { namespace: STAGING_NAMESPACE, name: `nia_stg_${hash}` };
}

/** One fixed, long-lived quarantine table per destination connection/database — never per-run, matching staging_objects' unique-per-connection partial index. */
export function deriveQuarantineEntity(): WriteEntityRef {
  return { namespace: STAGING_NAMESPACE, name: QUARANTINE_TABLE_NAME };
}

/**
 * Idempotent — a resumed run's first-chunk retry (or a redelivered stalled
 * job) calling this again is a no-op once the active row exists.
 *
 * `destEntity`/`destColumns`/`destUpsertKeys` (0022_staging_objects_dest_info.sql)
 * are persisted alongside the staging table's own name so the 24h sweeper
 * (stagingSweeper.ts) — which runs with no live EtlRunJob/graph context —
 * can reconstruct a valid signed StageRequest("drop") for a stale row on
 * its own.
 */
export async function registerStagingObject(
  runId: string,
  connectionId: string,
  entity: WriteEntityRef,
  destEntity: WriteEntityRef,
  destColumns: string[],
  destUpsertKeys: string[],
): Promise<void> {
  const existing = await withServiceRole(dbPool, (db) =>
    db.query(
      "select id from public.staging_objects where run_id = $1 and kind = 'staging' and status = 'active'",
      [runId],
    ),
  );
  if (existing.rows.length > 0) return;
  await withServiceRole(dbPool, (db) =>
    db.query(
      `insert into public.staging_objects
        (run_id, connection_id, schema_name, object_name, kind, status, dest_namespace, dest_name, dest_columns, dest_upsert_keys)
       values ($1, $2, $3, $4, 'staging', 'active', $5, $6, $7, $8)`,
      [runId, connectionId, entity.namespace, entity.name, destEntity.namespace, destEntity.name, destColumns, destUpsertKeys],
    ),
  );
}

/** Idempotent, same shape as registerStagingObject — see staging_objects_connection_quarantine_idx for the one-active-row-per-connection invariant this mirrors (best-effort on the worker side; the DB constraint is the real backstop). */
export async function registerQuarantineObject(connectionId: string, entity: WriteEntityRef): Promise<void> {
  const existing = await withServiceRole(dbPool, (db) =>
    db.query(
      "select id from public.staging_objects where connection_id = $1 and kind = 'quarantine' and status = 'active'",
      [connectionId],
    ),
  );
  if (existing.rows.length > 0) return;
  await withServiceRole(dbPool, (db) =>
    db.query(
      `insert into public.staging_objects (run_id, connection_id, schema_name, object_name, kind, status)
       values (null, $1, $2, $3, 'quarantine', 'active')`,
      [connectionId, entity.namespace, entity.name],
    ),
  );
}

export async function markStagingDropped(runId: string): Promise<void> {
  await withServiceRole(dbPool, (db) =>
    db.query(
      "update public.staging_objects set status = 'dropped', dropped_at = $1 where run_id = $2 and kind = 'staging' and status = 'active'",
      [new Date().toISOString(), runId],
    ),
  );
}

/**
 * Orphaned-destination-table lifecycle fix — registered ONLY when
 * ensureDestination() reports `created: true` (this run actually issued
 * the CREATE, never a pre-existing destination it merely writes into).
 * Same idempotent-insert shape as registerStagingObject: a resumed run's
 * first-chunk retry calling this again is a no-op once the active row
 * exists. `columns` is stored in `dest_columns` purely so a later chunk's
 * failStaged (a separate job invocation with no memory of this call) can
 * still build a valid signed WriteContext (`columns` requires at least
 * one entry) when it drops the entity — not otherwise consulted by a drop.
 */
export async function registerDestinationObject(
  runId: string,
  connectionId: string,
  entity: WriteEntityRef,
  columns: string[],
): Promise<void> {
  const existing = await withServiceRole(dbPool, (db) =>
    db.query(
      "select id from public.staging_objects where run_id = $1 and kind = 'destination' and status = 'active'",
      [runId],
    ),
  );
  if (existing.rows.length > 0) return;
  await withServiceRole(dbPool, (db) =>
    db.query(
      `insert into public.staging_objects (run_id, connection_id, schema_name, object_name, kind, status, dest_columns)
       values ($1, $2, $3, $4, 'destination', 'active', $5)`,
      [runId, connectionId, entity.namespace, entity.name, columns],
    ),
  );
}

export type ActiveDestinationObject = { entity: WriteEntityRef; columns: string[] };

/**
 * Looked up by failStaged on every terminal pre-apply failure. Returns
 * null when this run never created its own destination (direct mode, or
 * the destination already existed) — failStaged treats that as "nothing
 * to drop", same as dropStaging finding no staging row.
 */
export async function findActiveDestinationObject(runId: string): Promise<ActiveDestinationObject | null> {
  const result = await withServiceRole(dbPool, (db) =>
    db.query<{ schema_name: string; object_name: string; dest_columns: string[] | null }>(
      "select schema_name, object_name, dest_columns from public.staging_objects where run_id = $1 and kind = 'destination' and status = 'active'",
      [runId],
    ),
  );
  const data = result.rows[0];
  if (!data) return null;
  return {
    entity: { namespace: data.schema_name, name: data.object_name },
    columns: data.dest_columns ?? [],
  };
}

export async function markDestinationDropped(runId: string): Promise<void> {
  await withServiceRole(dbPool, (db) =>
    db.query(
      "update public.staging_objects set status = 'dropped', dropped_at = $1 where run_id = $2 and kind = 'destination' and status = 'active'",
      [new Date().toISOString(), runId],
    ),
  );
}

export async function persistStagingTable(runId: string, entity: WriteEntityRef): Promise<void> {
  await withServiceRole(dbPool, (db) =>
    db.query("update public.workflow_runs set staging_table = $1 where id = $2", [`${entity.namespace}.${entity.name}`, runId]),
  );
}

export type StaleStagingObject = {
  id: string;
  runId: string;
  connectionId: string;
  stagingEntity: WriteEntityRef;
  destEntity: WriteEntityRef | null;
  destColumns: string[] | null;
  destUpsertKeys: string[] | null;
};

/**
 * Rows the 24h sweeper (stagingSweeper.ts) should attempt to drop: still
 * `active`, `kind = 'staging'`, older than `olderThanMs`. Backed by
 * `staging_objects_sweep_idx` (0021_staging_registry.sql). `destEntity`/
 * `destColumns`/`destUpsertKeys` come back null for a row that predates
 * 0022_staging_objects_dest_info.sql — the sweeper skips those rather than
 * guessing (see that migration's header comment).
 */
type StagingObjectRow = {
  id: string;
  run_id: string | null;
  connection_id: string;
  schema_name: string;
  object_name: string;
  dest_namespace: string | null;
  dest_name: string | null;
  dest_columns: string[] | null;
  dest_upsert_keys: string[] | null;
};

export async function listStaleStagingObjects(olderThanMs: number): Promise<StaleStagingObject[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await withServiceRole(dbPool, (db) =>
    db.query<StagingObjectRow>(
      `select id, run_id, connection_id, schema_name, object_name, dest_namespace, dest_name, dest_columns, dest_upsert_keys
       from public.staging_objects
       where kind = 'staging' and status = 'active' and created_at < $1`,
      [cutoff],
    ),
  );
  return result.rows
    .filter((row): row is StagingObjectRow & { run_id: string } => row.run_id !== null)
    .map((row) => ({
      id: row.id,
      runId: row.run_id,
      connectionId: row.connection_id,
      stagingEntity: { namespace: row.schema_name, name: row.object_name },
      destEntity: row.dest_namespace && row.dest_name ? { namespace: row.dest_namespace, name: row.dest_name } : null,
      destColumns: row.dest_columns ?? null,
      destUpsertKeys: row.dest_upsert_keys ?? null,
    }));
}
