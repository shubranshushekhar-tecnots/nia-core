import type { SendEmailJob } from "@nia/schemas";
import { sendTemplatedMail } from "@nia/mail";
import { env } from "../../env.js";

/**
 * Email Phase 1 — worker-side half of generic email send (packages/mail
 * owns rendering + the transport; this just unwraps the job payload and
 * forwards it with this process's validated env). Letting this throw on
 * failure is intentional: BullMQ's own `attempts`/`backoff` (set by the
 * producer, see apps/web/src/lib/mail/mailQueue.ts) is what retries a
 * failed send — this handler must not swallow the error itself, or a
 * transient SMTP/Graph outage would silently drop the email on the first
 * try instead of retrying.
 */
export async function sendEmail(job: SendEmailJob): Promise<void> {
  try {
    await sendTemplatedMail(job.to, job.payload, env);
  } catch (err) {
    // Never log the rendered body/OTP/credentials — only enough to debug
    // transport connectivity.
    console.error(
      `[mail] send failed (template=${job.payload.template}): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
