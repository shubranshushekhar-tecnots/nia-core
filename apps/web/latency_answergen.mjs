/**
 * Phase 4 Task 4, Fix 2 — isolates the answer-gen first-delta hop: time
 * from the "generating_answer" status event's envelope ts to the first
 * "token" event's envelope ts (worker-side clock on both ends, same
 * pattern as latency_querygen.mjs's Fix 1 measurement).
 *
 * Run with (dev servers + docker-compose sandbox must already be up):
 *   node latency_answergen.mjs
 */
import { chromium } from "@playwright/test";

const RUNS = 10;
const CONNECTION_ID = "584b5bfb-e087-433d-aafa-93537ceb7dc7"; // @mysql-dev

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarize(label, values) {
  const clean = values.filter((v) => v !== undefined && !Number.isNaN(v));
  const sorted = [...clean].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(24)} n=${clean.length}  p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms`,
  );
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), n: clean.length };
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', "demo@nia.dev");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);
console.log("logged in at", page.url());

const hops = [];

for (let i = 0; i < RUNS; i++) {
  const postResp = await page.request.post("http://localhost:3100/api/backend/chat", {
    data: { message: "How many employees are there?", connectionIds: [CONNECTION_ID] },
    headers: { "Content-Type": "application/json" },
  });
  const { jobId } = await postResp.json();

  const result = await page.evaluate(async (jobId) => {
    const res = await fetch(`/api/backend/chat/stream?jobId=${jobId}`, { credentials: "include" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let genAnswerTs, firstTokenTs;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const envelope = JSON.parse(line.slice(6));
        const evt = envelope.event;
        if (evt.type === "status" && evt.stage === "generating_answer") genAnswerTs = envelope.ts;
        if (evt.type === "token" && genAnswerTs !== undefined && firstTokenTs === undefined) {
          firstTokenTs = envelope.ts;
        }
        if (["done", "error", "refused", "conflict"].includes(evt.type)) {
          return { genAnswerTs, firstTokenTs };
        }
      }
    }
    return { genAnswerTs, firstTokenTs };
  }, jobId);

  const hop =
    result.genAnswerTs !== undefined && result.firstTokenTs !== undefined
      ? result.firstTokenTs - result.genAnswerTs
      : undefined;

  hops.push(hop);
  console.log(`run ${i + 1}: answer-gen first-delta hop=${hop}ms`);
}

await browser.close();

console.log("\n=== answer-gen first-delta hop summary (p50 / p95 across 10 runs) ===");
summarize("answer-gen first-delta", hops);
