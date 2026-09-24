import { Redis } from "ioredis";
import type { RunStreamEvent } from "@nia/schemas";
import type { WorkspaceScope } from "@nia/db";
import { env } from "../../env.js";

/**
 * Publish-side run-event plumbing — byte-for-byte mirrors apps/worker/src/
 * lib/chat/publish.ts's shape (dedicated publisher/commands connections,
 * INCR'd seq, RPUSH-then-PUBLISH ordering, replay log with TTL/max-len),
 * substituting "run:events:" for "chat:events:" and (runId) for (jobId).
 * Duplicated rather than shared/generalized because apps/worker and
 * apps/api don't share a package for this (same reasoning as
 * chatChannel.ts's own header comment) — reuses the chat feature's
 * CHAT_EVENTS_LOG_TTL_MS/CHAT_EVENTS_LOG_MAX_LEN env vars rather than
 * adding new RUN_*-prefixed ones, since the tuning concern is identical.
 *
 * Keyed by (scope, runId) — runId is EtlRunJob.runId (server-minted at
 * enqueue time by apps/api's POST /:id/run), not any per-chunk BullMQ job
 * id: one run spans many discrete self-requeued jobs (see runEtl.ts), and
 * this channel must stay stable across all of them for a single SSE
 * subscriber to follow the whole run start to finish.
 */
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const commands = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

function keyFor(scope: WorkspaceScope): string {
  return "orgId" in scope ? `org:${scope.orgId}` : `user:${scope.ownerId}`;
}

/** Must stay byte-for-byte in sync with apps/api/src/lib/runChannel.ts's channelFor. */
export function channelFor(scope: WorkspaceScope, runId: string): string {
  return `run:events:${keyFor(scope)}:${runId}`;
}

/** Must stay byte-for-byte in sync with apps/api/src/lib/runChannel.ts's replayLogKeyFor. */
function replayLogKeyFor(scope: WorkspaceScope, runId: string): string {
  return `run:events:log:${keyFor(scope)}:${runId}`;
}

function seqKeyFor(scope: WorkspaceScope, runId: string): string {
  return `run:events:seq:${keyFor(scope)}:${runId}`;
}

export async function publishRunEvent(scope: WorkspaceScope, runId: string, event: RunStreamEvent): Promise<void> {
  const channel = channelFor(scope, runId);
  const listKey = replayLogKeyFor(scope, runId);
  const seqKey = seqKeyFor(scope, runId);
  const ttlSeconds = Math.ceil(env.CHAT_EVENTS_LOG_TTL_MS / 1000);

  const seq = await commands.incr(seqKey);
  const raw = JSON.stringify({ seq, ts: Date.now(), event });

  await commands
    .pipeline()
    .rpush(listKey, raw)
    .ltrim(listKey, -env.CHAT_EVENTS_LOG_MAX_LEN, -1)
    .expire(listKey, ttlSeconds)
    .expire(seqKey, ttlSeconds)
    .exec();

  await publisher.publish(channel, raw);
}
