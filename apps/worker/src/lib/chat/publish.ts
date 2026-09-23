import { Redis } from "ioredis";
import type { ChatStreamEvent } from "@nia/schemas";
import type { WorkspaceScope } from "../workspaceScope.js";
import { env } from "../../env.js";

/**
 * Dedicated publisher connection — kept separate from BullMQ's Redis
 * connection (index.ts) per ioredis convention: pub/sub and regular
 * command connections shouldn't be shared.
 *
 * apps/api's SSE route (routes/chat.ts's GET /chat/stream) subscribes to
 * this same channel and forwards every event verbatim to the browser as
 * SSE. Must stay byte-for-byte in sync with apps/api/src/lib/chatChannel.ts's
 * channelFor — duplicated rather than imported because apps/worker and
 * apps/api don't share a package for this.
 */
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Separate regular-command connection (INCR/RPUSH/LTRIM/EXPIRE) — never
 * shared with `publisher` above, same reasoning as the pub/sub-vs-commands
 * split everywhere else in this codebase.
 */
const commands = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Redis-safe key fragment for a WorkspaceScope — org and owner ids never
 * collide (org:<uuid> vs user:<uuid>) so a single scope resolves to one
 * unambiguous partition. Must stay byte-for-byte in sync with
 * apps/api/src/lib/chatChannel.ts's keyFor.
 */
function keyFor(scope: WorkspaceScope): string {
  return "orgId" in scope ? `org:${scope.orgId}` : `user:${scope.ownerId}`;
}

/**
 * Keyed by (scope, jobId) rather than the client-supplied conversationId —
 * jobId is server-minted at enqueue time (apps/api's POST /chat) and scope
 * comes from the authenticated actor, so neither half of the channel name
 * is attacker-controlled. This is what lets GET /chat/stream do a real
 * ownership check (requesting actor's scope === job's scope) before it ever
 * subscribes, instead of trusting a bare conversationId.
 */
export function channelFor(scope: WorkspaceScope, jobId: string): string {
  return `chat:events:${keyFor(scope)}:${jobId}`;
}

/**
 * Persisted replay log for the same job. Must stay byte-for-byte in sync
 * with apps/api/src/lib/chatChannel.ts's replayLogKeyFor (read side) —
 * duplicated for the same reason channelFor is.
 */
function replayLogKeyFor(scope: WorkspaceScope, jobId: string): string {
  return `chat:events:log:${keyFor(scope)}:${jobId}`;
}

function seqKeyFor(scope: WorkspaceScope, jobId: string): string {
  return `chat:events:seq:${keyFor(scope)}:${jobId}`;
}

/**
 * Publishes a ChatStreamEvent AND durably records it in a per-job replay
 * log, wrapped in a {seq, ts, event} envelope (@nia/schemas's
 * ChatStreamEnvelope). Plain Redis pub/sub has no memory: a subscriber that
 * attaches even a few milliseconds late silently misses anything published
 * before it — this is what let apps/api's GET /chat/stream drop the
 * resolving/introspecting/generating_query stage events entirely (Phase 4
 * exit latency investigation). The replay log fixes that: a late (or
 * reconnecting) subscriber LRANGEs this list instead of trusting pub/sub
 * alone (see apps/api/src/lib/sse.ts's subscribeWithReplay).
 *
 * `seq` is allocated via Redis INCR (not an in-process counter) because
 * multi-source's fan-out publishes concurrently from parallel per-source
 * work — an in-process counter would still be fine for ordering within one
 * Node process, but INCR is the same cost and removes any doubt.
 *
 * Write-then-notify ordering (RPUSH before PUBLISH) is deliberate: a
 * subscriber that receives the live PUBLISH is guaranteed the matching
 * RPUSH has already landed, so a concurrent LRANGE (done by a subscriber
 * that's *also* live-buffering that same message) can't ever miss an entry
 * that already reached the client with no replay-log backing.
 */
export async function publishChatEvent(scope: WorkspaceScope, jobId: string, event: ChatStreamEvent): Promise<void> {
  const channel = channelFor(scope, jobId);
  const listKey = replayLogKeyFor(scope, jobId);
  const seqKey = seqKeyFor(scope, jobId);
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
