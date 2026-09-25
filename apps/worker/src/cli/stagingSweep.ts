/**
 * One-shot staging sweep — the same logic the in-process BullMQ scheduler
 * (lib/etl/stagingSweepSchedule.ts) runs hourly inside the always-on worker,
 * exposed here as a standalone command so infra can run it as an external
 * scheduled job (cron/k8s CronJob) instead of, or in addition to, relying on
 * the worker process staying up. Lives under src/ (not scripts/, which is
 * dev/CI-only tooling run via `tsx` and excluded from the production
 * deploy image) so `tsc` compiles it into dist/ and it ships with the
 * worker image. Safe to run concurrently with the in-process schedule or
 * with itself — sweepStaleStaging only ever acts on rows already >24h
 * stale (see stagingSweeper.ts's header comment), and a row swept by one
 * caller is simply absent for the other.
 *
 * Run with (from apps/worker/):
 *   pnpm run sweep:staging          # dev, via tsx
 *   node dist/cli/stagingSweep.js   # production, from the built image
 *
 * Exits 0 if the sweep completed (even if some rows were skipped/failed —
 * those are already logged per-row by sweepStaleStaging), non-zero only if
 * the sweep itself threw (e.g. DB unreachable).
 */
import { sweepStaleStaging } from "../lib/etl/stagingSweeper.js";

async function main() {
  const result = await sweepStaleStaging();
  console.log(
    `[staging-sweep] done: swept=${result.swept} skipped=${result.skipped} failed=${result.failed}`,
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[staging-sweep] fatal:", err);
  process.exit(1);
});
