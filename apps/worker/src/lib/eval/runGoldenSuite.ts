/**
 * Runs fixtures/golden/chat-v1.jsonl end-to-end through the real chat
 * pipeline (runChatQuery.ts — the exact code path the real "interactive"
 * BullMQ worker runs, not a re-implementation) and scores each question on:
 *   (a) invariant satisfaction — did the outcome (answer/refused/conflict/
 *       no-connection) match, and for answers, did the content contain what
 *       it should (and omit what it shouldn't)?
 *   (b) citation reproduction — every citation the answer shipped with is
 *       re-executed via dispatch() (citationReproduction.ts) and must
 *       reproduce the same row count.
 *   (c) faithfulness verdict — for "answer"-type cases, the pipeline's own
 *       faithfulness check must have agreed (finalState.faithful === true).
 *   (d) latency — wall-clock ms per question, recorded (not gating).
 *
 * One HEAVY job runs the WHOLE suite (see EvalRunJob's header comment in
 * @nia/schemas jobs.ts) rather than fanning out into 20 BullMQ jobs — the
 * suite is a single logical unit (one report, one pass/fail gate), and
 * cross-job aggregation (waiting on 20 job completions, merging into one
 * report) would add real complexity for no behavioral benefit: nothing
 * here needs per-question queue-level retry/backoff, and 20 sequential
 * real-pipeline runs already take under a couple of minutes.
 *
 * Each question still gets its OWN Langfuse trace (runChatQuery calls
 * runInTrace per job, keyed by a synthetic per-question jobId) — so
 * per-question span trees are fully inspectable in Langfuse even though
 * they're not separate BullMQ jobs. The pass/fail verdict is attached back
 * to that trace via recordScore.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChatQueryJob } from "@nia/schemas";
import { env } from "../../env.js";
import { runChatQuery } from "../chat/runChatQuery.js";
import { recordScore, flushLangfuse } from "../observability/langfuse.js";
import { GoldenCase } from "./goldenCase.js";
import { seedSandbox, createConversation, getAssistantMessage, DEMO_USER_ID, INVALID_CONNECTION_ID, type ConnectorId } from "./sandbox.js";
import { reproduceCitation, type CitationReproductionResult } from "./citationReproduction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/golden/chat-v1.jsonl");
const REPORT_DIR = path.resolve(__dirname, "../../../eval-reports");

function loadGoldenCases(): GoldenCase[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => GoldenCase.parse(JSON.parse(line)));
}

export type EvalCaseResult = {
  id: string;
  message: string;
  pass: boolean;
  invariantPass: boolean;
  citationFailure: boolean;
  mustRefuseFailure: boolean;
  faithful: boolean | null;
  faithfulnessOutcome: "ok" | "conflict-retry" | "conflict-final" | null;
  answerGenAttempts: number | null;
  latencyMs: number;
  traceId: string;
  citations: CitationReproductionResult[];
  notes: string[];
};

export type EvalReport = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    citationFailures: number;
    mustRefuseFailures: number;
  };
  results: EvalCaseResult[];
};

/**
 * Strips thousands-separator commas from numbers before comparing (e.g. the
 * model renders sums as "$1,395,000" — a correct answer that a naive
 * substring check against "1395" would wrongly fail). Matching is otherwise
 * a plain case-insensitive substring check.
 */
function contentIncludes(content: string, needle: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1");
  return normalize(content).includes(normalize(needle));
}

export async function runGoldenSuite(): Promise<EvalReport> {
  // Refused even if an eval_run job somehow reaches a production worker
  // (e.g. manually enqueued) — see schedule.ts, which is the primary gate.
  if (env.NODE_ENV === "production") {
    throw new Error("runGoldenSuite refused: NODE_ENV=production — this seeds the docker-compose sandbox DBs and is dev/CI only");
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const cases = loadGoldenCases();
  const { orgId, connectionIds: seeded } = await seedSandbox();

  const results: EvalCaseResult[] = [];

  for (const kase of cases) {
    const jobId = randomUUID();
    const conversationId = await createConversation(orgId);
    const connectionIds = kase.connectors.map((c) => (c === "invalid" ? INVALID_CONNECTION_ID : seeded[c as ConnectorId]));

    const payload: ChatQueryJob = {
      kind: "chat_query",
      scope: { orgId },
      userId: DEMO_USER_ID,
      conversationId,
      message: kase.message,
      connectionIds,
    };

    const notes: string[] = [];
    const start = Date.now();
    let result;
    try {
      result = await runChatQuery(payload, jobId);
    } catch (err) {
      result = { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Date.now() - start;

    const message = await getAssistantMessage(conversationId);
    const content = message?.content ?? "";
    const citations = message?.citations ?? [];

    let invariantPass = true;
    let mustRefuseFailure = false;
    let faithful: boolean | null = null;
    let faithfulnessOutcome: "ok" | "conflict-retry" | "conflict-final" | null = null;
    let answerGenAttempts: number | null = null;

    switch (kase.expect.type) {
      case "answer": {
        if (result.status !== "ok") {
          invariantPass = false;
          notes.push(`expected an answer, got status=${result.status}`);
        } else {
          faithful = result.faithful;
          faithfulnessOutcome = result.faithfulnessOutcome ?? null;
          answerGenAttempts = result.answerGenAttempts;
          const expectedOutcome = kase.expect.expectFaithfulnessOutcome ?? "ok";
          if (expectedOutcome === "conflict-final") {
            // Engineered case: the pipeline's faithfulness retry loop must
            // actually fire once and still ship unfaithful — not just any
            // faithful:false. A plain first-try disagreement (no retry) or
            // a first-try faithful:true would both be a fixture-design
            // failure here, not a pass.
            if (result.faithfulnessOutcome !== "conflict-final" || result.answerGenAttempts !== 1) {
              invariantPass = false;
              notes.push(
                `expected faithfulnessOutcome=conflict-final after exactly one retry, got outcome=${result.faithfulnessOutcome} attempts=${result.answerGenAttempts}`,
              );
            }
          } else if (!result.faithful) {
            invariantPass = false;
            notes.push("faithfulness check disagreed with the shipped answer");
          }
          for (const needle of kase.expect.mustContain ?? []) {
            if (!contentIncludes(content, needle)) {
              invariantPass = false;
              notes.push(`answer missing expected content: "${needle}"`);
            }
          }
          for (const needle of kase.expect.mustNotContain ?? []) {
            if (contentIncludes(content, needle)) {
              invariantPass = false;
              notes.push(`answer contains content it should not: "${needle}"`);
            }
          }
        }
        break;
      }
      case "refused": {
        if (result.status !== "refused") {
          invariantPass = false;
          mustRefuseFailure = true;
          notes.push(`expected a refusal, got status=${result.status}`);
        } else if (kase.expect.refusalKind && result.reason !== kase.expect.refusalKind) {
          invariantPass = false;
          mustRefuseFailure = true;
          notes.push(`expected refusalKind=${kase.expect.refusalKind}, got ${result.reason}`);
        }
        break;
      }
      case "conflict": {
        if (result.status !== "conflict") {
          invariantPass = false;
          notes.push(`expected a conflict, got status=${result.status}`);
        }
        break;
      }
      case "no-connection": {
        if (result.status !== "error" || (result as { reason?: string }).reason !== "no-connection-selected") {
          invariantPass = false;
          mustRefuseFailure = true;
          notes.push(`expected the no-connection-selected path, got status=${result.status}`);
        }
        for (const needle of kase.expect.mustContain ?? []) {
          if (!contentIncludes(content, needle)) {
            invariantPass = false;
            notes.push(`message missing expected content: "${needle}"`);
          }
        }
        break;
      }
    }

    const citationResults: CitationReproductionResult[] = [];
    for (const citation of citations) {
      citationResults.push(await reproduceCitation(citation, { orgId }, DEMO_USER_ID));
    }
    const citationFailure = citationResults.some((c) => !c.reproduced);
    if (citationFailure) notes.push("one or more citations did not reproduce the same row count on re-execution");

    const pass = invariantPass && !citationFailure;

    recordScore({ traceId: jobId, name: "golden_eval", value: pass ? 1 : 0, comment: notes.join("; ") || undefined });

    results.push({
      id: kase.id,
      message: kase.message,
      pass,
      invariantPass,
      citationFailure,
      mustRefuseFailure,
      faithful,
      faithfulnessOutcome,
      answerGenAttempts,
      latencyMs,
      traceId: jobId,
      citations: citationResults,
      notes,
    });
  }

  await flushLangfuse();

  const finishedAt = new Date().toISOString();
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    citationFailures: results.filter((r) => r.citationFailure).length,
    mustRefuseFailures: results.filter((r) => r.mustRefuseFailure).length,
  };
  const report: EvalReport = { runId, startedAt, finishedAt, summary, results };

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, `${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(REPORT_DIR, "latest.json"), JSON.stringify(report, null, 2));

  return report;
}
