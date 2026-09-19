/**
 * On-demand entry point for the Phase 7 Copilot plan-propose golden suite
 * (see src/lib/eval/runPlanGoldenSuite.ts). Run with:
 *   npx tsx scripts/run-plan-golden-eval.ts
 * (reads apps/worker/.env via dotenv/config; same prerequisites as
 * run-golden-eval.ts: supabase start, docker compose sandbox DBs +
 * connector services running.)
 *
 * Exits non-zero if any case fails, so this is safe to wire into CI later
 * without extra glue.
 */
import { runPlanGoldenSuite } from "../src/lib/eval/runPlanGoldenSuite.js";

async function main() {
  const report = await runPlanGoldenSuite();
  const { summary } = report;

  console.log(`\nPlan golden eval run ${report.runId}`);
  console.log(`${summary.passed}/${summary.total} passed`);

  for (const result of report.results) {
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} (status=${result.status}, ${result.latencyMs}ms)`);
    if (!result.pass) {
      console.log(`  ${result.notes.join("; ")}`);
    }
  }

  const gateOk = summary.failed === 0;
  console.log(`\nacceptance gate: ${gateOk ? "PASS" : "FAIL"}`);
  process.exit(gateOk ? 0 : 1);
}

main().catch((err) => {
  console.error("plan golden eval run crashed:", err);
  process.exit(1);
});
