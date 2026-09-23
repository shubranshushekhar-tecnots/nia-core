import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, SchemaRefreshJob, IntrospectResponse } from "@nia/schemas";
import { env } from "../env.js";
import { AppError } from "./appError.js";

/**
 * Express-side BullMQ producer for schema_refresh jobs — same module-
 * level-singleton, request/response (waitUntilFinished, not SSE) pattern
 * as checksQueue.ts, since a schema refresh is exactly as bounded and
 * fast as a check run (one connector /introspect call). See
 * apps/worker/src/lib/schema/refreshSchema.ts's header comment for why
 * this round trip exists at all: it busts the WORKER's own introspection
 * cache, a separate process from this one.
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });
const queueEvents = new QueueEvents(QUEUE_INTERACTIVE, { connection });

export async function runSchemaRefreshJob(job: Omit<SchemaRefreshJob, "kind">): Promise<IntrospectResponse> {
  const timeoutMs = env.SCHEMA_REFRESH_TIMEOUT_MS;
  const jobId = randomUUID();
  const bullJob = await queue.add("schema_refresh", SchemaRefreshJob.parse({ kind: "schema_refresh", ...job }), { jobId });

  let outcome: unknown;
  try {
    outcome = await bullJob.waitUntilFinished(queueEvents, timeoutMs);
  } catch (err) {
    throw new AppError(
      503,
      "SCHEMA_REFRESH_WORKER_UNAVAILABLE",
      `The workflow worker did not complete this schema refresh within ${timeoutMs}ms. It may be offline or overloaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = IntrospectResponse.safeParse(outcome);
  if (!parsed.success) {
    throw new AppError(500, "SCHEMA_REFRESH_MALFORMED", `Worker returned a malformed schema_refresh result: ${parsed.error.message}`);
  }
  return parsed.data;
}
