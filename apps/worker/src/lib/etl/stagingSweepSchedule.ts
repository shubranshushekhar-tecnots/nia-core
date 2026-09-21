/**
 * Registers a single repeatable `staging_sweep` job on the HEAVY queue via
 * BullMQ's upsertJobScheduler — same idempotent-at-boot pattern as
 * lib/eval/schedule.ts's registerNightlyEvalSchedule (keyed by a fixed
 * schedulerId, so restarting the worker never creates duplicate repeatable
 * jobs).
 *
 * Cron pattern comes from env.STAGING_SWEEP_CRON (default hourly) — see
 * that env var's doc comment for why the sweep cadence and the 24h
 * staleness cutoff it enforces per-row are two independent numbers.
 */
import type { Queue } from "bullmq";
import { env } from "../../env.js";

const SCHEDULER_ID = "staging-sweep";

export async function registerStagingSweepSchedule(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: env.STAGING_SWEEP_CRON },
    { name: "staging_sweep", data: { kind: "staging_sweep" } },
  );
}
