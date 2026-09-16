import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

const browser = await chromium.launch();

// --- org-A: log in, POST /chat to mint a real jobId owned by org-A ---
const ctxA = await browser.newContext();
const pageA = await ctxA.newPage();
await pageA.goto("http://localhost:3100/login");
await pageA.fill('input[name="email"]', "demo@nia.dev");
await pageA.fill('input[name="password"]', "password");
await Promise.all([
  pageA.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  pageA.locator('button[type="submit"]').first().click(),
]);
console.log("org-A logged in at", pageA.url());

const cid = randomUUID();
const postResp = await pageA.request.post("http://localhost:3100/api/backend/chat", {
  data: {
    conversationId: cid,
    message: "How many employees are there?",
    connectionIds: ["584b5bfb-e087-433d-aafa-93537ceb7dc7"],
  },
  headers: { "Content-Type": "application/json" },
});
console.log("org-A POST /chat status:", postResp.status());
const postBody = await postResp.json();
console.log("org-A POST /chat body:", postBody);
const jobId = postBody.jobId;

// --- org-B: log in (separate isolated context = separate cookie jar), then try to stream org-A's jobId ---
const ctxB = await browser.newContext();
const pageB = await ctxB.newPage();
await pageB.goto("http://localhost:3100/login");
await pageB.fill('input[name="email"]', "probe-b@nia.dev");
await pageB.fill('input[name="password"]', "password12345");
await Promise.all([
  pageB.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  pageB.locator('button[type="submit"]').first().click(),
]);
console.log("org-B logged in at", pageB.url());

const streamResp = await pageB.request.get(
  `http://localhost:3100/api/backend/chat/stream?jobId=${jobId}`,
  { timeout: 15000 },
);
console.log("org-B GET /chat/stream status:", streamResp.status());
const streamBody = await streamResp.text();
console.log("org-B GET /chat/stream body:", streamBody);

const eventCount = streamBody.split("\n").filter((l) => l.startsWith("data:")).length;
console.log("SSE events received:", eventCount);

if (streamResp.status() === 403 && eventCount === 0) {
  console.log("PROBE D: PASS (403, zero events)");
} else {
  console.log("PROBE D: FAIL");
}

await browser.close();
