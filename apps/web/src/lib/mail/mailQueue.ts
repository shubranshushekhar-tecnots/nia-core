import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, SendEmailJob } from "@nia/schemas";

/**
 * apps/web has no Express layer to hold a module-level singleton that's
 * safe to construct at import time — `next build`'s page-data-collection
 * step imports every route module (including ones that transitively import
 * this file) without REDIS_URL set, so the Queue/Redis connection must not
 * be constructed at module-import time. Same lazy-singleton rationale as
 * lib/db/pool.ts's getPool(); only actually connects the first time
 * enqueueEmail() is called (i.e. at request time).
 */
let queue: Queue | undefined;

function getMailQueue(): Queue {
  if (!queue) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is not set");
    }
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_INTERACTIVE, { connection });
  }
  return queue;
}

/**
 * Fire-and-forget email send — enqueued onto the same `interactive` queue
 * apps/worker already consumes (apps/worker/src/index.ts's `send_email`
 * case), never the `heavy` queue, since a mail send is cheap/fast and must
 * never block the Server Action that triggered it (OTP request, password
 * reset, etc). Explicit attempts/backoff here (not just relying on a
 * worker-side retry loop) because transient SMTP/Graph outages are
 * expected and should resolve on their own within a couple minutes.
 */
export async function enqueueEmail(job: SendEmailJob): Promise<void> {
  await getMailQueue().add("send_email", SendEmailJob.parse(job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });
}
