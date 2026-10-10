import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_INTERACTIVE, SendEmailJob } from "@nia/schemas";
import { env } from "../env.js";

/**
 * Email Phase 3 — apps/api needs to send email directly from the new
 * console routes (access-request approve/reject, platform-invite create/
 * resend), none of which have an apps/web Server Action in the loop. Same
 * module-level BullMQ producer convention as chatQueue.ts (apps/api always
 * has REDIS_URL validated at boot via env.ts, unlike apps/web's lazy
 * getMailQueue() which has to tolerate next build's page-data-collection
 * step importing modules with no env set).
 */
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_INTERACTIVE, { connection });

/** Same fire-and-forget, 3-attempt exponential-backoff shape as apps/web's enqueueEmail. */
export async function enqueueEmail(job: SendEmailJob): Promise<void> {
  await queue.add("send_email", SendEmailJob.parse(job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });
}
