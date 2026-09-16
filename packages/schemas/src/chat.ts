import { z } from "zod";

/**
 * Events the worker's chat pipeline (apps/worker/src/lib/chat/graph.ts)
 * publishes over Redis pub/sub as it runs, and apps/web's SSE route
 * (apps/web/src/app/api/chat/route.ts) forwards verbatim to the browser.
 *
 * `truncated` rides on the `citation` AND `token`/`done` events (not just
 * buried in meta) so the UI can render a truncation warning purely from the
 * stream shape, regardless of whether the model's prose mentions it.
 * `faithful: false` on `done` means the second (and final) faithfulness
 * check still flagged a conflict — the answer ships anyway (no infinite
 * loop) but the client MUST surface that, not hide it.
 */
export const ChatStreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    // "validating" was never emitted and has been removed (fix-pass Step
    // 4): guardrail validation runs synchronously inside dispatch(), the
    // same chokepoint dispatchNode.ts already reports as "executing" — it
    // has no separately-observable boundary of its own for a graph node to
    // publish from.
    stage: z.enum([
      "rewriting",
      "planning_reduction",
      "resolving",
      "introspecting",
      "generating_query",
      "executing",
      "generating_answer",
      "checking_faithfulness",
    ]),
  }),
  z.object({
    type: z.literal("token"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("citation"),
    connectionId: z.string().uuid(),
    executedQuery: z.string(),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("done"),
    /** False when the faithfulness check still conflicted after the one allowed regeneration. */
    faithful: z.boolean(),
    /** True when ANY contributing source's result was truncated (multi-source only; optional so single-source's exact-equality tests are untouched). */
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("refused"),
    /**
     * "unsupported-operation": the question doesn't fit a reducible shape
     *   (planReduction said `supported: false`) — refused before any
     *   source is touched, nothing generated or dispatched.
     * "partial-failure": at least one requested source failed or timed
     *   out. MAX/MIN/SUM/COUNT are never safe to compute from a subset of
     *   sources (a missing source could always change the true answer),
     *   so the whole request is refused rather than answered from
     *   survivors.
     * "capacity-limit": more sources were requested than MAX_SOURCES
     *   allows — a request-shape limit, not a judgment about whether the
     *   question is answerable. Kept distinct so the client can render
     *   "you selected too many sources" instead of a correctness failure.
     */
    kind: z.enum(["unsupported-operation", "partial-failure", "capacity-limit"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("conflict"),
    /** Plain-language description of what the sources disagreed about — distinct from a single-source faithfulness conflict, which is `done.faithful: false`. */
    message: z.string(),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

/**
 * Wire/replay-log envelope around a ChatStreamEvent. `seq` is a per-job
 * monotonically increasing counter (assigned by apps/worker/src/lib/chat/
 * publish.ts via Redis INCR — safe under multi-source's concurrent per-
 * source publishes, where plain pub/sub alone gives no ordering guarantee).
 * `ts` is the worker-side Date.now() at publish time, used both for replay
 * ordering/dedup and for latency hop measurement (compare against a
 * client's own receipt timestamp).
 *
 * Every event is published as this envelope (not a bare ChatStreamEvent) so
 * a client that subscribes late — or reconnects mid-stream via `?after=` on
 * GET /chat/stream — can be handed the exact same shape whether it came
 * from live pub/sub or from the persisted replay log (RPUSH'd alongside
 * every PUBLISH, see publish.ts). apps/api/src/lib/sse.ts's
 * subscribeWithReplay is the shared, chat-agnostic consumer of this shape.
 */
export const ChatStreamEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  event: ChatStreamEvent,
});
export type ChatStreamEnvelope = z.infer<typeof ChatStreamEnvelope>;
