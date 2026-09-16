import { chromium } from "@playwright/test";

const CONNECTION_ID = "584b5bfb-e087-433d-aafa-93537ceb7dc7";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', "demo@nia.dev");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);

const t0 = Date.now();
const postResp = await page.request.post("http://localhost:3100/api/backend/chat", {
  data: { message: "How many employees are there?", connectionIds: [CONNECTION_ID] },
  headers: { "Content-Type": "application/json" },
});
const tAfterPost = Date.now();
const { jobId } = await postResp.json();
console.log("POST took", tAfterPost - t0, "ms, jobId=", jobId);

const events = await page.evaluate(async ({ jobId, t0 }) => {
  const tBeforeFetch = Date.now();
  const res = await fetch(`/api/backend/chat/stream?jobId=${jobId}`, { credentials: "include" });
  const tAfterFetch = Date.now();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const log = [{ marker: "fetch-open", ms: tAfterFetch - t0 }];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const now = Date.now();
      const evt = JSON.parse(line.slice(6));
      log.push({ type: evt.type, stage: evt.stage, ms: now - t0 });
      if (["done", "error", "refused", "conflict"].includes(evt.type)) return log;
    }
  }
  return log;
}, { jobId, t0 });

console.log(JSON.stringify(events, null, 2));
await browser.close();
