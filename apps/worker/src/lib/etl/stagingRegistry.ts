import { createHash } from "node:crypto";
import type { WriteEntityRef } from "@nia/schemas";
import { supabase } from "../supabaseClient.js";

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
  const { data } = await supabase
    .from("staging_objects")
    .select("id")
    .eq("run_id", runId)
    .eq("kind", "staging")
    .eq("status", "active")
    .maybeSingle();
  if (data) return;
  await supabase.from("staging_objects").insert({
    run_id: runId,
    connection_id: connectionId,
    schema_name: entity.namespace,
    object_name: entity.name,
    kind: "staging",
    status: "active",
    dest_namespace: destEntity.namespace,
    dest_name: destEntity.name,
    dest_columns: destColumns,
    dest_upsert_keys: destUpsertKeys,
  });
}

/** Idempotent, same shape as registerStagingObject — see staging_objects_connection_quarantine_idx for the one-active-row-per-connection invariant this mirrors (best-effort on the worker side; the DB constraint is the real backstop). */
export async function registerQuarantineObject(connectionId: string, entity: WriteEntityRef): Promise<void> {
  const { data } = await supabase
    .from("staging_objects")
    .select("id")
    .eq("connection_id", connectionId)
    .eq("kind", "quarantine")
    .eq("status", "active")
    .maybeSingle();
  if (data) return;
  await supabase.from("staging_objects").insert({
    run_id: null,
    connection_id: connectionId,
    schema_name: entity.namespace,
    object_name: entity.name,
    kind: "quarantine",
    status: "active",
  });
}

export async function markStagingDropped(runId: string): Promise<void> {
  await supabase
    .from("staging_objects")
    .update({ status: "dropped", dropped_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("kind", "staging")
    .eq("status", "active");
}

export async function persistStagingTable(runId: string, entity: WriteEntityRef): Promise<void> {
  await supabase.from("workflow_runs").update({ staging_table: `${entity.namespace}.${entity.name}` }).eq("id", runId);
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
export async function listStaleStagingObjects(olderThanMs: number): Promise<StaleStagingObject[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { data } = await supabase
    .from("staging_objects")
    .select("id, run_id, connection_id, schema_name, object_name, dest_namespace, dest_name, dest_columns, dest_upsert_keys")
    .eq("kind", "staging")
    .eq("status", "active")
    .lt("created_at", cutoff);
  if (!data) return [];
  return data
    .filter((row): row is typeof row & { run_id: string } => row.run_id !== null)
    .map((row) => ({
      id: row.id as string,
      runId: row.run_id,
      connectionId: row.connection_id as string,
      stagingEntity: { namespace: row.schema_name as string, name: row.object_name as string },
      destEntity:
        row.dest_namespace && row.dest_name
          ? { namespace: row.dest_namespace as string, name: row.dest_name as string }
          : null,
      destColumns: (row.dest_columns as string[] | null) ?? null,
      destUpsertKeys: (row.dest_upsert_keys as string[] | null) ?? null,
    }));
}
