import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, PreviewJob, PreviewOutcome, type PreviewValue } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Express-side BullMQ producer for preview_run jobs — same
 * module-level-singleton + waitUntilFinished pattern as checksQueue.ts and
 * mappingsQueue.ts. No streaming need here either (one PreviewValue, not a
 * sequence of partial results), so this reuses the same proven
 * timeout-guarded request/response pattern rather than standing up SSE.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

/**
 * `opts.timeoutMs` exists solely so a future previewQueue.timeout.test.ts
 * can force a near-instant timeout against real Redis without waiting out
 * the real env.PREVIEW_TIMEOUT_MS default — production callers never pass
 * it. Throws AppError both for a worker-side timeout/crash AND for a
 * well-formed-but-`ok:false` outcome (e.g. "mapping-not-approved",
 * "entity-unresolved") — the service layer's caller only ever needs one
 * failure path to handle, distinguished by AppError's code.
 */
export async function runPreviewJob(
  job: Omit<PreviewJob, "kind">,
  opts: { timeoutMs?: number } = {},
): Promise<PreviewValue> {
  const timeoutMs = opts.timeoutMs ?? env.PREVIEW_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("preview_run", PreviewJob.parse({ kind: "preview_run", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "PREVIEW_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this preview within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = PreviewOutcome.safeParse(outcome);
  if (!parsed.success) {
    throw new AppError(500, "PREVIEW_MALFORMED", `Worker returned a malformed preview_run result: ${parsed.error.message}`);
  }
  if (!parsed.data.ok) {
    throw new AppError(422, "PREVIEW_FAILED", parsed.data.error.message);
  }
  return parsed.data.value;
}
