import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("request", (req) => { if (req.url().includes("/checks")) console.log("[req]", req.method(), req.url()); });
page.on("response", async (res) => {
  if (res.url().includes("/checks")) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.log("[res]", res.status(), res.url(), body.slice(0, 3000));
  }
});
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', "demo@nia.dev");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }),
  page.locator('button[type="submit"]').first().click(),
]);
await page.goto("http://localhost:3100/app/workflows/bbe6e6ad-97cd-444b-9219-d0020de88d28");
await page.waitForTimeout(1500);
console.log(">>> clicking Run checks");
await page.getByRole("button", { name: "Run checks", exact: true }).click();
await page.waitForTimeout(15000);
console.log(">>> done waiting 15s");
await page.screenshot({ path: "/tmp/checks-worker-live.png", fullPage: true });
await browser.close();
