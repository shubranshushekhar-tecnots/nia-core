import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, ProposeMappingJob, ProposeMappingOutcome, type ProposalSchema } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Express-side BullMQ producer for mappings_propose jobs — same
 * module-level-singleton + waitUntilFinished pattern as checksQueue.ts.
 * Chosen over the SSE util (used by chat) for the same reason checks made
 * that choice: this is a single request/response outcome (one proposal, not
 * a stream of incremental events), so reusing the proven timeout-guarded
 * pattern keeps the two "worker job called synchronously from an HTTP
 * route" paths in the codebase consistent, rather than standing up SSE
 * infrastructure for a call that never streams partial results.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

/**
 * `opts.timeoutMs` exists solely so a future mappingsQueue.timeout.test.ts
 * can force a near-instant timeout against real Redis without waiting out
 * the real env.MAPPING_PROPOSE_TIMEOUT_MS default — production callers
 * never pass it. Throws AppError both for a worker-side timeout/crash AND
 * for a well-formed-but-`ok:false` outcome (e.g. "homogeneous path", "no
 * upstream source") — the service layer's caller only ever needs one
 * failure path to handle, distinguished by AppError's code.
 */
export async function runProposeMappingJob(
  job: Omit<ProposeMappingJob, "kind">,
  opts: { timeoutMs?: number } = {},
): Promise<ProposalSchema> {
  const timeoutMs = opts.timeoutMs ?? env.MAPPING_PROPOSE_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("mappings_propose", ProposeMappingJob.parse({ kind: "mappings_propose", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "MAPPING_PROPOSE_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this mapping proposal within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = ProposeMappingOutcome.safeParse(outcome);
  if (!parsed.success) {
    throw new AppError(500, "MAPPING_PROPOSE_MALFORMED", `Worker returned a malformed mappings_propose result: ${parsed.error.message}`);
  }
  if (!parsed.data.ok) {
    throw new AppError(422, "MAPPING_PROPOSE_FAILED", parsed.data.error.message);
  }
  return parsed.data.value;
}
