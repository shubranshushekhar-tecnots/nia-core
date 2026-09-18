import { z } from "zod";

/**
 * Events the worker's ETL runner (apps/worker/src/lib/etl/runEtl.ts)
 * publishes over Redis pub/sub as a workflow run progresses through its
 * chunks, forwarded verbatim by apps/api's SSE route (GET
 * /workflows/:id/run/stream) to the browser. Mirrors chat.ts's
 * ChatStreamEvent/ChatStreamEnvelope pattern exactly (envelope with a
 * per-run monotonic `seq`, replay-log-backed reconnect support via
 * apps/api/src/lib/sse.ts's subscribeWithReplay) — worker and api don't
 * share a package for the pub/sub plumbing itself (apps/worker/src/lib/
 * chat/publish.ts's channel/key helpers are duplicated, not imported, by
 * apps/worker/src/lib/etl/publish.ts), only this schema is shared.
 */
export const RunStreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    nodeId: z.string(),
  }),
  z.object({
    type: z.literal("progress"),
    nodeId: z.string(),
    rowsReadThisChunk: z.number().int().nonnegative(),
    rowsWrittenThisChunk: z.number().int().nonnegative(),
    totalRowsProcessed: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("done"),
    nodeId: z.string(),
    totalRowsProcessed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    nodeId: z.string().optional(),
    message: z.string(),
  }),
]);
export type RunStreamEvent = z.infer<typeof RunStreamEvent>;

/** Wire/replay-log envelope — see ChatStreamEnvelope's comment for the full rationale, identical here. */
export const RunStreamEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  event: RunStreamEvent,
});
export type RunStreamEnvelope = z.infer<typeof RunStreamEnvelope>;
