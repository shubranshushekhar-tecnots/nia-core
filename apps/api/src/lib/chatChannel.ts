import type { WorkspaceScope } from "./workspaceScope.js";

/**
 * Redis-safe key fragment for a WorkspaceScope — org and owner ids never
 * collide (org:<uuid> vs user:<uuid>) so a single scope resolves to one
 * unambiguous partition. Must stay byte-for-byte in sync with
 * apps/worker/src/lib/chat/publish.ts's keyFor.
 */
function keyFor(scope: WorkspaceScope): string {
  return "orgId" in scope ? `org:${scope.orgId}` : `user:${scope.ownerId}`;
}

/**
 * Must stay byte-for-byte in sync with apps/worker/src/lib/chat/publish.ts's
 * channelFor — that's the publish side, this is the subscribe side, and
 * they have to agree on the exact channel string. Duplicated rather than
 * imported because apps/worker and apps/api don't share a package for this.
 *
 * Keyed by (scope, jobId), not the client-supplied conversationId — scope
 * is the job's WorkspaceScope (org id or owner id) and jobId is
 * server-minted at enqueue time, so neither half of the channel name is
 * attacker-controlled. This is what lets GET /chat/stream do a real
 * ownership check (requesting actor's scope === job's scope) before it
 * ever subscribes, instead of trusting a bare conversationId.
 */
export function channelFor(scope: WorkspaceScope, jobId: string): string {
  return `chat:events:${keyFor(scope)}:${jobId}`;
}

/**
 * Must stay byte-for-byte in sync with apps/worker/src/lib/chat/publish.ts's
 * replayLogKeyFor (the write side) — the persisted per-job event log a late
 * or reconnecting subscriber replays from, since plain pub/sub has no
 * memory for messages published before a subscriber attaches. See
 * apps/api/src/lib/sse.ts's subscribeWithReplay for the read side.
 */
export function replayLogKeyFor(scope: WorkspaceScope, jobId: string): string {
  return `chat:events:log:${keyFor(scope)}:${jobId}`;
}
