/**
 * Phase 4 exit-criteria latency probe: measures time-to-first-stage-event
 * and time-to-first-token for a single-source chat query, through the REAL
 * client-facing path (browser -> Next.js /api/backend/chat rewrite ->
 * apps/api -> BullMQ -> apps/worker -> Redis pub/sub -> apps/api SSE ->
 * browser), not chat-smoke.ts's direct graph.invoke() bypass.
 *
 * Logs in once via Playwright (demo@nia.dev, same as login_capture.mjs),
 * then runs N sequential single-source queries against the @mysql-dev
 * connection, timing from the moment the POST /chat request is sent to:
 *   - the first SSE event of any kind (time-to-first-stage-event)
 *   - the first `token` event (time-to-first-token)
 * Prints p50/p95 for both. Run with: node latency_probe.mjs
 */
import { chromium } from "@playwright/test";

const RUNS = 10;
const CONNECTION_ID = "584b5bfb-e087-433d-aafa-93537ceb7dc7"; // @mysql-dev

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
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

const stageMs = [];
const tokenMs = [];
const details = [];

for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  const postResp = await page.request.post("http://localhost:3100/api/backend/chat", {
    data: { message: "How many employees are there?", connectionIds: [CONNECTION_ID] },
    headers: { "Content-Type": "application/json" },
  });
  const { jobId } = await postResp.json();

  const result = await page.evaluate(
    async ({ jobId, t0 }) => {
      const res = await fetch(`/api/backend/chat/stream?jobId=${jobId}`, { credentials: "include" });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let firstStageMs, firstTokenMs;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const now = Date.now();
          if (firstStageMs === undefined) firstStageMs = now - t0;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "token" && firstTokenMs === undefined) firstTokenMs = now - t0;
          if (["done", "error", "refused", "conflict"].includes(evt.type)) return { firstStageMs, firstTokenMs };
        }
      }
      return { firstStageMs, firstTokenMs };
    },
    { jobId, t0 },
  );

  stageMs.push(result.firstStageMs);
  if (result.firstTokenMs !== undefined) tokenMs.push(result.firstTokenMs);
  details.push({ run: i + 1, jobId, ...result });
  console.log(`run ${i + 1}: firstStage=${result.firstStageMs}ms firstToken=${result.firstTokenMs}ms`);
}

await browser.close();

const sortedStage = [...stageMs].sort((a, b) => a - b);
const sortedToken = [...tokenMs].sort((a, b) => a - b);

console.log("\n=== summary ===");
console.log(JSON.stringify({ details }, null, 2));
console.log(`time-to-first-stage-event: p50=${percentile(sortedStage, 50)}ms p95=${percentile(sortedStage, 95)}ms`);
console.log(`time-to-first-token:       p50=${percentile(sortedToken, 50)}ms p95=${percentile(sortedToken, 95)}ms`);
