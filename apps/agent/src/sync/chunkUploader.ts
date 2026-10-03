/**
 * Cut back for the v4 migration's slice A1 (docs/plans/planometry-v4-
 * migration.md §10, §966): the old chunk-upload loop (PlanometryClient
 * .pushChunk, HeartbeatScheduler, ChunkRejectedError) depended entirely
 * on the deleted work-queue wire protocol and is gone. `backoffDelayMs()`
 * is kept exactly as-is — a later slice reuses this exact exponential-
 * backoff mechanism around the v4 push client's retry loop (400 never
 * retries; only network/5xx does, per the connector guide §6).
 */
export function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exp + jitter;
}
