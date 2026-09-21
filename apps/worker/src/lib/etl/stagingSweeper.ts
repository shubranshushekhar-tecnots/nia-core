import { supabase } from "../supabaseClient.js";
import { listStaleStagingObjects, deriveQuarantineEntity } from "./stagingRegistry.js";
import { dropStagingByEntity } from "./stagedWrite.js";
import type { WorkspaceScope } from "../workspaceScope.js";

/**
 * Phase 11 item 12 — the 24h sweeper. Registered as a repeatable BullMQ job
 * (stagingSweepSchedule.ts) rather than tied to any single run: a run's own
 * `dropStaging` call (stagedWrite.ts) is the primary cleanup path (on
 * successful apply or terminal failure); this is the backstop for whatever
 * that missed — a worker that crashed mid-run, a chunk job that got stuck
 * and was never redelivered, etc. (see 0021_staging_registry.sql's header
 * comment: "only ever drop names in the registry").
 *
 * Runs with no live EtlRunJob/graph context, so it reconstructs each drop
 * request purely from `staging_objects` (via listStaleStagingObjects, which
 * already carries the destination entity/columns/upsertKeys persisted at
 * registerStagingObject time — see 0022_staging_objects_dest_info.sql) plus
 * a direct read of the row's own connection for the WorkspaceScope/actor a
 * signed StageRequest needs.
 */
export type SweepResult = { swept: number; skipped: number; failed: number };

type ConnectionScopeRow = { org_id: string | null; owner_id: string | null; owner_user_id: string };

async function resolveConnectionScope(
  connectionId: string,
): Promise<{ scope: WorkspaceScope; actorUserId: string } | null> {
  const { data } = await supabase
    .from("connections")
    .select("org_id, owner_id, owner_user_id")
    .eq("id", connectionId)
    .maybeSingle<ConnectionScopeRow>();
  if (!data) return null;
  const scope: WorkspaceScope = data.org_id ? { orgId: data.org_id } : { ownerId: data.owner_id! };
  return { scope, actorUserId: data.owner_user_id };
}

export async function sweepStaleStaging(olderThanMs = 24 * 60 * 60 * 1000): Promise<SweepResult> {
  const stale = await listStaleStagingObjects(olderThanMs);
  let swept = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of stale) {
    if (!row.destEntity || !row.destColumns || !row.destUpsertKeys) {
      // Predates 0022_staging_objects_dest_info.sql, or was registered
      // before that migration's columns were populated — can't safely
      // reconstruct a signed drop request. Left `active`; an operator can
      // still see it via staging_objects for manual cleanup.
      console.warn(`[staging-sweep] skipping ${row.id} (run ${row.runId}): missing destination info`);
      skipped++;
      continue;
    }
    const resolved = await resolveConnectionScope(row.connectionId);
    if (!resolved) {
      // connection_id is `on delete cascade` from connections, so this only
      // happens in a narrow race (row deleted between the list query and
      // here) — nothing to drop against, treat as already-gone.
      console.warn(`[staging-sweep] skipping ${row.id}: connection ${row.connectionId} no longer exists`);
      skipped++;
      continue;
    }
    try {
      await dropStagingByEntity(
        row.connectionId,
        row.stagingEntity,
        deriveQuarantineEntity(),
        row.destEntity,
        row.destColumns,
        row.destUpsertKeys,
        row.runId,
        resolved.scope,
        resolved.actorUserId,
      );
      swept++;
    } catch (err) {
      console.error(`[staging-sweep] failed to drop ${row.id} (run ${row.runId}):`, err);
      failed++;
    }
  }

  return { swept, skipped, failed };
}
