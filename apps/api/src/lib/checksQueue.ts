import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, CheckRunJob, CheckResult } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Express-side BullMQ producer for check_run jobs — same module-level-
 * singleton pattern as chatQueue.ts, same queue (checks are explicitly
 * "interactive," per jobs.ts's header comment). Unlike chat, this is a
 * request/response operation, not a stream: checks are bounded and fast
 * (pure graph inspection + a handful of connector /test calls), so this
 * blocks the HTTP request on the job's completion via BullMQ's own
 * waitUntilFinished instead of standing up an SSE/pub-sub relay for what's
 * fundamentally a "run these checks, get a list back" call — that
 * infrastructure exists for chat's LLM streaming, not needed here.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

/**
 * `opts.timeoutMs` exists solely so checksQueue.timeout.test.ts can force a
 * near-instant timeout against real Redis without waiting out the real
 * env.CHECK_RUN_TIMEOUT_MS default — production callers never pass it.
 */
export async function runCheckRunJob(job: Omit<CheckRunJob, "kind">, opts: { timeoutMs?: number } = {}): Promise<CheckResult[]> {
  const timeoutMs = opts.timeoutMs ?? env.CHECK_RUN_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("check_run", CheckRunJob.parse({ kind: "check_run", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "CHECK_RUN_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this check run within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = CheckResult.array().safeParse((outcome as { results?: unknown } | undefined)?.results);
  if (!parsed.success) {
    throw new AppError(500, "CHECK_RUN_MALFORMED", `Worker returned a malformed check_run result: ${parsed.error.message}`);
  }
  return parsed.data;
}
