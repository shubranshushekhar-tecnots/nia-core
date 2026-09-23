import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, CleanProposeJob, CleanProposeOutcome, type CleanProposalResult } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Phase 13, Step 7 — Express-side BullMQ producer for clean_propose jobs.
 * Same module-level-singleton + waitUntilFinished pattern as
 * mappingsQueue.ts/profileQueue.ts: a single request/response outcome (one
 * proposal, not a stream of incremental events), so this reuses the same
 * proven timeout-guarded pattern rather than standing up SSE
 * infrastructure for a call that never streams partial results.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

/**
 * `opts.timeoutMs` exists solely so a future cleanQueue.timeout.test.ts can
 * force a near-instant timeout against real Redis without waiting out the
 * real env.CLEAN_PROPOSE_TIMEOUT_MS default — production callers never
 * pass it. Throws AppError both for a worker-side timeout/crash AND for a
 * well-formed-but-`ok:false` outcome (e.g. "no upstream source", "entity
 * not found") — the service layer's caller only ever needs one failure
 * path to handle, distinguished by AppError's code.
 */
export async function runProposeCleaningJob(job: Omit<CleanProposeJob, "kind">, opts: { timeoutMs?: number } = {}): Promise<CleanProposalResult> {
  const timeoutMs = opts.timeoutMs ?? env.CLEAN_PROPOSE_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("clean_propose", CleanProposeJob.parse({ kind: "clean_propose", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "CLEAN_PROPOSE_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this cleaning proposal within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = CleanProposeOutcome.safeParse(outcome);
  if (!parsed.success) {
    throw new AppError(500, "CLEAN_PROPOSE_MALFORMED", `Worker returned a malformed clean_propose result: ${parsed.error.message}`);
  }
  if (!parsed.data.ok) {
    throw new AppError(422, "CLEAN_PROPOSE_FAILED", parsed.data.error.message);
  }
  return parsed.data.value;
}
