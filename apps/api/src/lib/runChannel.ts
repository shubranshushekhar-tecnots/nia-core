import type { WorkspaceScope } from "./workspaceScope.js";

/**
 * Subscribe-side mirror of apps/worker/src/lib/etl/publish.ts's keyFor /
 * channelFor / replayLogKeyFor — same org:<uuid>/user:<uuid> partitioning as
 * chatChannel.ts, just under a "run:events:" prefix instead of
 * "chat:events:" so the two event streams never collide on the same key
 * space. Duplicated rather than imported because apps/worker and apps/api
 * don't share a package for this (same rationale as chatChannel.ts).
 *
 * Keyed by (scope, runId), not anything client-supplied — runId is
 * server-minted at enqueue time (routes/workflows.ts's POST /:id/run), so
 * GET /:id/run/stream can do a real ownership check (requesting actor's
 * scope === job's scope) before ever subscribing.
 */
function keyFor(scope: WorkspaceScope): string {
  return "orgId" in scope ? `org:${scope.orgId}` : `user:${scope.ownerId}`;
}

export function channelFor(scope: WorkspaceScope, runId: string): string {
  return `run:events:${keyFor(scope)}:${runId}`;
}

export function replayLogKeyFor(scope: WorkspaceScope, runId: string): string {
  return `run:events:log:${keyFor(scope)}:${runId}`;
}
