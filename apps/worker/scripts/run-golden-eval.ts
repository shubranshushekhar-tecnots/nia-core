/**
 * On-demand entry point for the golden-set eval suite (the same code path
 * the nightly `eval_run` HEAVY job runs — see src/lib/eval/runGoldenSuite.ts
 * and src/lib/eval/schedule.ts). Run with:
 *   npx tsx scripts/run-golden-eval.ts
 * (reads apps/worker/.env via dotenv/config, same prerequisites as
 * chat-smoke.ts: supabase start, docker compose sandbox DBs + connector
 * services running).
 *
 * Exits non-zero if the suite doesn't clear the acceptance gate (>=18/20
 * passing, zero citation failures, zero must-refuse failures) so this is
 * safe to wire into CI later without extra glue.
 */
import { runGoldenSuite } from "../src/lib/eval/runGoldenSuite.js";

const ACCEPTANCE_MIN_PASSED = 18;

async function main() {
  const report = await runGoldenSuite();
  const { summary } = report;

  console.log(`\nGolden eval run ${report.runId}`);
  console.log(`${summary.passed}/${summary.total} passed`);
  console.log(`citation failures: ${summary.citationFailures}`);
  console.log(`must-refuse failures: ${summary.mustRefuseFailures}`);

  for (const result of report.results) {
    if (!result.pass) {
      console.log(`\nFAIL ${result.id}: ${result.notes.join("; ")}`);
    }
  }

  const gateOk =
    summary.passed >= ACCEPTANCE_MIN_PASSED &&
    summary.citationFailures === 0 &&
    summary.mustRefuseFailures === 0;

  console.log(`\nacceptance gate: ${gateOk ? "PASS" : "FAIL"}`);
  process.exit(gateOk ? 0 : 1);
}

main().catch((err) => {
  console.error("golden eval run crashed:", err);
  process.exit(1);
});
