import { Redis } from "ioredis";
import { createHash } from "node:crypto";
import type { Column, StructuredFilterCondition, StructuredQueryCursor } from "@nia/schemas";

/**
 * Slice T2, plan point 2 — the read-ahead cache. One batch an agent has
 * already uploaded, keyed by the exact (connection, table, columns, filter,
 * limit, startingCursor) tuple that produced it, so the next /execute call
 * for "the next cursor" is served without creating a new agent_tasks row.
 *
 * A separate dedicated Redis connection from apps/worker's (same `ioredis`
 * convention — a plain `new Redis(url)` per feature file, not a shared
 * client module, see apps/worker/src/lib/etl/publish.ts's own header) —
 * this service has never needed Redis before this slice.
 */
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

/** "live in Redis for 2 minutes" (plan point 2), literally. */
const BATCH_TTL_SECONDS = 120;

export interface CachedBatch {
  columns: Column[];
  rows: unknown[][];
  nextCursor: StructuredQueryCursor | null;
  isLast: boolean;
}

/**
 * Identifies "the same read" independent of which agent_tasks row produced
 * it — two /execute calls for the same table/columns/filter/limit (whatever
 * their cursor) share one signature, so every batch an agent uploads under
 * one read-ahead task lands under the same signature prefix. Deliberately
 * excludes cursor (that is folded into batchKeyFor separately) and rowCap/
 * timeoutMs (per-call transport knobs, not part of "what query is this").
 */
export function signatureKeyFor(
  connectionId: string,
  table: string,
  columns: string[],
  filter: StructuredFilterCondition[],
  limit: number,
): string {
  const canonical = JSON.stringify({ connectionId, table, columns, filter, limit });
  return createHash("sha256").update(canonical).digest("hex");
}

/** One cache entry per (signature, starting cursor) — "keyed by its starting cursor" (plan point 2/3). */
export function batchKeyFor(signatureKey: string, cursor: StructuredQueryCursor | null): string {
  const cursorPart = cursor ? `${cursor.column}:${String(cursor.value)}` : "start";
  return `readbatch:${signatureKey}:${cursorPart}`;
}

/**
 * "removed when served" (plan point 2) — GETDEL is atomic in Redis 6.2+/
 * ioredis 5, so two /execute calls racing for the same cache entry can
 * never both get it.
 */
export async function takeCachedBatch(cacheKey: string): Promise<CachedBatch | null> {
  const raw = await redis.getdel(cacheKey);
  return raw ? (JSON.parse(raw) as CachedBatch) : null;
}

export async function putCachedBatch(cacheKey: string, batch: CachedBatch): Promise<void> {
  await redis.set(cacheKey, JSON.stringify(batch), "EX", BATCH_TTL_SECONDS);
}

/** Test-only — lets the Allowed/Refused tests close the connection cleanly instead of leaking an open socket per test file. */
export async function closeReadAheadRedis(): Promise<void> {
  await redis.quit();
}
