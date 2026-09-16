/**
 * Phase 4 Task 4, Fix 1 — isolates the query-gen hop specifically:
 * time from the "generating_query" status event's envelope ts to the very
 * next status event's envelope ts (single-source pipeline goes
 * generating_query -> executing, so this brackets exactly the
 * completeJson() call in generateQuery.ts, nothing else). Worker-side
 * clock on both ends, so client/network jitter is excluded.
 *
 * Run with (dev servers + docker-compose sandbox must already be up):
 *   node latency_querygen.mjs
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

  const stages = await page.evaluate(async (jobId) => {
    const res = await fetch(`/api/backend/chat/stream?jobId=${jobId}`, { credentials: "include" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const out = [];
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
        if (evt.type === "status") out.push({ stage: evt.stage, ts: envelope.ts });
        if (["done", "error", "refused", "conflict"].includes(evt.type)) return out;
      }
    }
    return out;
  }, jobId);

  const genIdx = stages.findIndex((s) => s.stage === "generating_query");
  const genHop =
    genIdx !== -1 && stages[genIdx + 1] ? stages[genIdx + 1].ts - stages[genIdx].ts : undefined;

  hops.push(genHop);
  console.log(`run ${i + 1}: stages=${stages.map((s) => s.stage).join(",")} generating_query hop=${genHop}ms`);
}

await browser.close();

console.log("\n=== query-gen hop summary (p50 / p95 across 10 runs) ===");
summarize("generating_query hop", hops);
