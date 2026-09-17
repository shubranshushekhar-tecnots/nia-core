/**
 * Phase 4 latency remediation — Task 3 re-measurement. Runs single-source
 * chat queries through the REAL client-facing path (browser -> Next.js
 * /api/backend/chat rewrite -> apps/api -> BullMQ -> apps/worker -> Redis
 * pub/sub+replay-log -> apps/api SSE -> browser), same as the superseded
 * latency_probe.mjs, but with hop-level instrumentation instead of a single
 * end-to-end number, per the remediation spec:
 *
 *   1. POST accepted        — BullMQ job.timestamp (enqueue() call, inside
 *                              the POST handler), read straight out of the
 *                              `bull:interactive:<jobId>` Redis hash after
 *                              the run — a real server-side timestamp, not
 *                              a client-perceived round trip.
 *   2. Job picked up         — BullMQ job.processedOn (Worker's processor
 *                              function starts), same hash.
 *   3. Each stage start      — the `status` SSE events' envelope `ts`
 *                              (apps/worker/src/lib/chat/publish.ts stamps
 *                              this at RPUSH/PUBLISH time) — worker-side
 *                              clock, not client receipt.
 *   4. First token generated — the first `token` SSE event's envelope `ts`
 *                              (worker-side, same mechanism as #3).
 *   5. Client receipt        — Date.now() in the browser when the SSE line
 *                              is parsed off the fetch stream.
 *
 * "First token byte written (api side)" is not separately instrumented:
 * apps/api's SSE route (lib/sse.ts) writes synchronously the instant it
 * receives the Redis pub/sub message (Task 2 already removed the only
 * buffering source, Node's header-flush delay), so on this same-machine,
 * no-proxy setup the api-write and client-receipt timestamps are
 * indistinguishable within measurement noise — instrumenting it separately
 * would mean adding a permanent console.log to the hot path for a one-off
 * number. Hop 5 minus hop 4 ("worker publish -> client receipt") is
 * reported instead, and stated as bundling api-forward + network, both
 * negligible on localhost.
 *
 * Run with (dev servers + docker-compose sandbox must already be up):
 *   node latency_hops.mjs
 */
import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";

const RUNS = 10;
const CONNECTION_ID = "d103a00c-9335-41d1-9d01-f22a4c654db2"; // @mysql-dev — re-resolved Session 4 Block 0, Phase 4's id is stale (seed data was recreated since)

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarize(label, values) {
  const clean = values.filter((v) => v !== undefined && !Number.isNaN(v));
  const sorted = [...clean].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} n=${clean.length}  p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms`,
  );
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), n: clean.length };
}

function bullJobHash(jobId) {
  const raw = execSync(
    `docker compose exec -T redis redis-cli HGETALL "bull:interactive:${jobId}"`,
    { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf-8" },
  );
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const hash = {};
  for (let i = 0; i < lines.length; i += 2) hash[lines[i]] = lines[i + 1];
  return hash;
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

const runs = [];

for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  const postResp = await page.request.post("http://localhost:3100/api/backend/chat", {
    data: { message: "How many employees are there?", connectionIds: [CONNECTION_ID] },
    headers: { "Content-Type": "application/json" },
  });
  const { jobId } = await postResp.json();

  const streamResult = await page.evaluate(
    async ({ jobId, t0 }) => {
      const res = await fetch(`/api/backend/chat/stream?jobId=${jobId}`, { credentials: "include" });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const stages = [];
      let firstTokenEnvelopeTs, firstTokenClientMs;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const clientMs = Date.now() - t0;
          const envelope = JSON.parse(line.slice(6));
          const evt = envelope.event;
          if (evt.type === "status") stages.push({ stage: evt.stage, envelopeTs: envelope.ts, clientMs });
          if (evt.type === "token" && firstTokenEnvelopeTs === undefined) {
            firstTokenEnvelopeTs = envelope.ts;
            firstTokenClientMs = clientMs;
          }
          if (["done", "error", "refused", "conflict"].includes(evt.type)) {
            return { stages, firstTokenEnvelopeTs, firstTokenClientMs, terminalType: evt.type };
          }
        }
      }
      return { stages, firstTokenEnvelopeTs, firstTokenClientMs, terminalType: undefined };
    },
    { jobId, t0 },
  );

  const hash = bullJobHash(jobId);
  const enqueuedAt = hash.timestamp ? Number(hash.timestamp) : undefined;
  const pickedUpAt = hash.processedOn ? Number(hash.processedOn) : undefined;
  const firstStage = streamResult.stages[0];

  const hops = {
    postToEnqueue: enqueuedAt !== undefined ? enqueuedAt - t0 : undefined, // client POST send -> BullMQ enqueue (server clock)
    enqueueToPickup: enqueuedAt !== undefined && pickedUpAt !== undefined ? pickedUpAt - enqueuedAt : undefined,
    pickupToFirstStage: pickedUpAt !== undefined && firstStage ? firstStage.envelopeTs - pickedUpAt : undefined,
    firstStageToFirstToken:
      firstStage && streamResult.firstTokenEnvelopeTs !== undefined
        ? streamResult.firstTokenEnvelopeTs - firstStage.envelopeTs
        : undefined,
    workerPublishToClientReceipt:
      streamResult.firstTokenEnvelopeTs !== undefined && streamResult.firstTokenClientMs !== undefined
        ? t0 + streamResult.firstTokenClientMs - streamResult.firstTokenEnvelopeTs
        : undefined,
    totalFirstStageEvent: firstStage?.clientMs,
    totalFirstToken: streamResult.firstTokenClientMs,
  };

  runs.push({ run: i + 1, jobId, enqueuedAt, pickedUpAt, stages: streamResult.stages, hops });
  console.log(
    `run ${i + 1}: totalFirstStageEvent=${hops.totalFirstStageEvent}ms totalFirstToken=${hops.totalFirstToken}ms ` +
      `postToEnqueue=${hops.postToEnqueue}ms enqueueToPickup=${hops.enqueueToPickup}ms ` +
      `pickupToFirstStage=${hops.pickupToFirstStage}ms firstStageToFirstToken=${hops.firstStageToFirstToken}ms ` +
      `workerPublishToClientReceipt=${hops.workerPublishToClientReceipt}ms`,
  );
}

await browser.close();

console.log("\n=== per-run detail ===");
console.log(JSON.stringify(runs, null, 2));

console.log("\n=== hop summary (p50 / p95 across 10 runs) ===");
summarize("POST send -> BullMQ enqueue", runs.map((r) => r.hops.postToEnqueue));
summarize("Enqueue -> worker picks up job", runs.map((r) => r.hops.enqueueToPickup));
summarize("Pickup -> first stage event", runs.map((r) => r.hops.pickupToFirstStage));
summarize("First stage -> first token (worker)", runs.map((r) => r.hops.firstStageToFirstToken));
summarize("Worker publish -> client receipt", runs.map((r) => r.hops.workerPublishToClientReceipt));
summarize("TOTAL: POST send -> first stage event (client)", runs.map((r) => r.hops.totalFirstStageEvent));
summarize("TOTAL: POST send -> first token (client)", runs.map((r) => r.hops.totalFirstToken));
