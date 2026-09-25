/**
 * Nightly golden-set eval schedule. Registers a single repeatable `eval_run`
 * job on the HEAVY queue via BullMQ's upsertJobScheduler — keyed by a fixed
 * schedulerId, so calling this at every worker boot is idempotent (it
 * updates the existing scheduler in place rather than creating duplicate
 * repeatable jobs on every restart).
 *
 * Cron pattern comes from env.EVAL_NIGHTLY_CRON (default 03:00 daily) so
 * the schedule can be tuned per-environment without a code change.
 */
import type { Queue } from "bullmq";
import { env } from "../../env.js";

const SCHEDULER_ID = "nightly-golden-eval";

/**
 * Never registered in production: the golden suite seeds connections against
 * the docker-compose sandbox DBs (dev-mysql/dev-mongo/dev-postgres,
 * hardcoded nia_ro/nia_ro_pw creds — see sandbox.ts) that don't exist outside
 * local/CI. This is a dev/CI quality gate, not customer-facing behavior.
 */
export async function registerNightlyEvalSchedule(queue: Queue): Promise<void> {
  if (env.NODE_ENV === "production") {
    console.log("[eval] skipping nightly golden-eval schedule — dev/CI only, not registered in production");
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: env.EVAL_NIGHTLY_CRON },
    { name: "eval_run", data: { kind: "eval_run" } },
  );
}
