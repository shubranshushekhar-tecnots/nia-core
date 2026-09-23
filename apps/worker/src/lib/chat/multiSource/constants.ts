/**
 * Bounds on the multi-source fan-out. Hardcoded (not env-configurable) —
 * this is a correctness/availability boundary, not a tuning knob.
 */

/**
 * More than this many connectionIds is refused outright as a capacity limit
 * — see nodes/planReduction.ts and index.ts's job-handler branching.
 * Re-exported from @nia/schemas (Phase 5 Session 4) so apps/api's request
 * validation can't drift from the worker's own refusal threshold.
 */
export { MAX_SOURCES } from "@nia/schemas";

/** At most this many per-source pipelines run concurrently, so a large fan-out can't open unbounded connections at once. */
export const FANOUT_CONCURRENCY = 3;

/** A single source pipeline (resolve -> schema -> query -> dispatch, including its own retries) is given this long before it's treated as failed. One slow source can never hang the whole request past this ceiling. */
export const SOURCE_PIPELINE_TIMEOUT_MS = 30_000;
