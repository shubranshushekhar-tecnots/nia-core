/**
 * Runs fixtures/golden/plan-v1.jsonl end-to-end through the real
 * plan-propose pipeline (runPlanPropose.ts — the exact code path the real
 * "interactive" BullMQ worker runs for a `plan_propose` job, not a
 * re-implementation). Same one-question-at-a-time, single-report shape as
 * runGoldenSuite.ts (see that file's header comment for why this isn't
 * fanned out into N BullMQ jobs), scoring each case on:
 *   (a) outcome type — did runPlanPropose land on the expected status
 *       ("ok" -> "plan", "clarify", "refused", or "no-connection")?
 *   (b) for "plan"-type cases: did the shipped Plan clear expect.minNodes?
 *   (c) for "refused"-type cases: did refusalKind match, when asserted?
 * No citation-reproduction/faithfulness axis here — those are chat-
 * specific (a plan never ships prose answers to re-verify), so this
 * intentionally has a narrower EvalCaseResult than runGoldenSuite.ts's.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PlanProposeJob } from "@nia/schemas";
import { runPlanPropose } from "../plan/runPlanPropose.js";
import { PlanGoldenCase } from "./planGoldenCase.js";
import { seedSandbox, createConversation, DEMO_USER_ID } from "./sandbox.js";
import { seedPlanWorkflow, seedHighCardinalityTable, seedHeadroomTable, seedResidualCapTable } from "./planSandbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/golden/plan-v1.jsonl");
const REPORT_DIR = path.resolve(__dirname, "../../../eval-reports");

/**
 * Test-only override of plan.ts's RESIDUAL_PLAN_AGGREGATE_GROUP_CAP (real
 * value: 100,000) — read by apps/worker/src/lib/plan/nodes/
 * validateFeasibility.ts, same "process.env override, never in a .env /
 * env.ts's validated schema" convention as runEtl.ts's RESIDUAL_GROUP_CAP.
 * Set here, only for this harness's process, so the
 * "aggregate-residual-cap-breach" golden case (planSandbox.ts's
 * seedResidualCapTable, 60 rows) can genuinely breach the cap without
 * seeding six figures of real rows. Safe to set process-wide for this
 * entire suite run: every other case's aggregate is either not residual
 * (always pushed, never capped) or has too few groups to hit 50 either
 * way, so only this one case's outcome is actually affected.
 */
process.env.PLAN_RESIDUAL_GROUP_CAP = "50";

function loadGoldenCases(): PlanGoldenCase[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => PlanGoldenCase.parse(JSON.parse(line)));
}

export type PlanEvalCaseResult = {
  id: string;
  message: string;
  pass: boolean;
  status: string;
  latencyMs: number;
  notes: string[];
};

export type PlanEvalReport = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: { total: number; passed: number; failed: number };
  results: PlanEvalCaseResult[];
};

export async function runPlanGoldenSuite(): Promise<PlanEvalReport> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cases = loadGoldenCases();
  const { orgId } = await seedSandbox();
  seedHighCardinalityTable();
  seedHeadroomTable();
  seedResidualCapTable();

  const results: PlanEvalCaseResult[] = [];

  for (const kase of cases) {
    const jobId = randomUUID();
    const workflowId = await seedPlanWorkflow(orgId);
    const conversationId = await createConversation(orgId);

    const payload: PlanProposeJob = {
      kind: "plan_propose",
      scope: { orgId },
      userId: DEMO_USER_ID,
      triggeredByUserId: DEMO_USER_ID,
      workflowId,
      conversationId,
      message: kase.message,
    };

    const notes: string[] = [];
    const start = Date.now();
    let result;
    try {
      result = await runPlanPropose(payload, jobId);
    } catch (err) {
      result = { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - start;

    let pass = true;

    switch (kase.expect.type) {
      case "plan": {
        if (result.status !== "ok") {
          pass = false;
          notes.push(`expected status=ok (a plan), got status=${result.status}${"error" in result ? `: ${result.error}` : ""}`);
        } else if (kase.expect.minNodes !== undefined && result.plan.nodes.length < kase.expect.minNodes) {
          pass = false;
          notes.push(`expected >= ${kase.expect.minNodes} nodes, got ${result.plan.nodes.length}`);
        }
        break;
      }
      case "clarify": {
        if (result.status !== "clarify") {
          pass = false;
          notes.push(`expected status=clarify, got status=${result.status}`);
        }
        break;
      }
      case "refused": {
        if (result.status !== "refused") {
          pass = false;
          notes.push(`expected status=refused, got status=${result.status}`);
        } else if (kase.expect.refusalKind && result.kind !== kase.expect.refusalKind) {
          pass = false;
          notes.push(`expected refusalKind=${kase.expect.refusalKind}, got ${result.kind}`);
        }
        break;
      }
      case "no-connection": {
        if (result.status !== "no-connection") {
          pass = false;
          notes.push(`expected status=no-connection, got status=${result.status}`);
        }
        break;
      }
      case "capacity-safety": {
        // Scores the safety PROPERTY ("no over-cap plan ever reaches
        // apply"), not one exact path — see planGoldenCase.ts's doc
        // comment and docs/decisions.md's safety-property-scoring entry.
        // Passes on either a capacity-limit refusal or a clarify; fails on
        // an applyable `ok` plan (the property is actually violated) or
        // any other status (doesn't exercise the property).
        if (result.status === "refused") {
          if (result.kind !== "capacity-limit") {
            pass = false;
            notes.push(`expected a capacity-limit refusal (safety property), got refusalKind=${result.kind}`);
          }
        } else if (result.status !== "clarify") {
          pass = false;
          notes.push(
            `safety property violated: expected a capacity-limit refusal or a clarify (never an applyable plan for a plan that breaches the residual group cap), got status=${result.status}`,
          );
        }
        break;
      }
    }

    results.push({
      id: kase.id,
      message: kase.message,
      pass,
      status: result.status,
      latencyMs,
      notes,
    });
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
  };
  const report: PlanEvalReport = { runId, startedAt, finishedAt, summary, results };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, `plan-${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(REPORT_DIR, "plan-latest.json"), JSON.stringify(report, null, 2));

  return report;
}
