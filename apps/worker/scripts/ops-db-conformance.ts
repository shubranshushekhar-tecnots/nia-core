/**
 * Phase 8b-2a, Deliverable 2 — DB-execution conformance for OP_FIXTURES.
 *
 * `ops.conformance.test.ts` (packages/schemas) already proves every
 * OP_REGISTRY x pushable-dialect pair compiles to the exact expected
 * `dialectQuery` SHAPE. That's necessary but not sufficient: an emission
 * can look exactly right and still execute wrong (see docs/decisions.md's
 * Phase 8a entry — this is the named blocking prerequisite it flags).
 * This script closes that gap by running every fixture that declares a
 * `dbCase` (packages/schemas/src/ops/__conformance__/fixtures.ts) through
 * the REAL production path — compilePushdown -> buildEtlReadQuery ->
 * dispatch() (apps/worker/scripts/lib/dbHarness.ts) — against a seeded
 * scratch table/collection in the docker-compose sandbox, and asserts the
 * actual returned rows equal `dbCase.expectedRows`.
 *
 * Registry-driven like ops.conformance.test.ts: iterates OP_FIXTURES
 * (not OP_REGISTRY directly) so it naturally covers whatever fixtures
 * declare `dbCase`, with no per-op wiring here.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/ops-db-conformance.ts
 *
 * Prerequisites (not started by this script — same as dispatch-smoke.ts):
 *   - `supabase start`
 *   - `docker compose up -d redis dev-mysql dev-mongo dev-postgres
 *     connector-mysql connector-mongodb connector-supabase`
 *   - `pnpm --filter @nia/schemas build` (this script imports OP_FIXTURES
 *     from @nia/schemas's built dist, not source — rebuild after editing
 *     fixtures.ts)
 */
import { compilePushdown, OP_FIXTURES, type SourceDialect } from "@nia/schemas";
import {
  provisionMysqlFixture,
  provisionPostgresFixture,
  provisionMongoFixture,
  runCompiledQuery,
  diffRows,
  type ProvisionedFixture,
} from "./lib/dbHarness.js";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function provisionFor(dialect: SourceDialect, seedRows: Record<string, unknown>[]): Promise<ProvisionedFixture> {
  if (dialect === "mysql") return provisionMysqlFixture(seedRows);
  if (dialect === "postgres") return provisionPostgresFixture(seedRows);
  return provisionMongoFixture(seedRows);
}

async function main(): Promise<void> {
  const cases = OP_FIXTURES.filter((f) => f.dbCase);
  log(`=== ops-db-conformance: ${cases.length} fixture(s) with a dbCase ===\n`);

  let failures = 0;
  const cleanups: Array<() => Promise<void>> = [];

  for (const fixture of cases) {
    const { seedRows, expectedRows } = fixture.dbCase!;
    const label = `${fixture.opKind}/${fixture.dialect}: ${fixture.description}`;
    const known = fixture.knownFailure;

    // A known-failure fixture never contributes to the run's pass/fail exit
    // code — it reports XFAIL (still failing, as expected) or XPASS (fixed;
    // remove the marker). Any OTHER fixture failing is a genuine, untriaged
    // regression and still fails the run immediately, so a real regression
    // can't hide behind this mechanism.
    try {
      const provisioned = await provisionFor(fixture.dialect, seedRows);
      cleanups.push(provisioned.cleanup);

      const plan = compilePushdown(fixture.dialect, fixture.config);
      if (plan.residualCount > 0) {
        const msg = `expected fully pushed down (0 residual steps), got ${plan.residualCount} residual`;
        if (known) {
          log(`  XFAIL ${label}`);
          log(`        (known: ${known.reason} — ${known.decisionsRef})`);
          log(`        ${msg}`);
        } else {
          failures++;
          log(`  FAIL  ${label}`);
          log(`        ${msg}`);
        }
        continue;
      }

      const actual = await runCompiledQuery(fixture.dialect, provisioned, plan.dialectQuery);
      const mismatches = diffRows(label, actual, expectedRows);
      if (mismatches.length === 0) {
        if (known) {
          log(`  XPASS ${label}`);
          log(`        (marked knownFailure but passed — remove the marker: ${known.decisionsRef})`);
        } else {
          log(`  PASS  ${label}`);
        }
      } else if (known) {
        log(`  XFAIL ${label}`);
        log(`        (known: ${known.reason} — ${known.decisionsRef})`);
        for (const m of mismatches) log(`        ${m}`);
      } else {
        failures++;
        log(`  FAIL  ${label}`);
        for (const m of mismatches) log(`        ${m}`);
      }
    } catch (err) {
      const msg = `threw: ${err instanceof Error ? err.message : String(err)}`;
      if (known) {
        log(`  XFAIL ${label}`);
        log(`        (known: ${known.reason} — ${known.decisionsRef})`);
        log(`        ${msg}`);
      } else {
        failures++;
        log(`  FAIL  ${label}`);
        log(`        ${msg}`);
      }
    }
  }

  log("\n=== cleanup ===");
  for (const cleanup of cleanups) {
    await cleanup().catch((err) => log(`  cleanup warning: ${err instanceof Error ? err.message : String(err)}`));
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
