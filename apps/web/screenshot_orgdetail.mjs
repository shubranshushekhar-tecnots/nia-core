import { chromium } from "@playwright/test";

const email = "demo@nia.dev";
const password = "password";
const orgId = "e6bf7df7-32e8-497e-8c77-91f096037020";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);
await page.waitForTimeout(500);

await page.goto(`http://localhost:3100/console/orgs/${orgId}`);
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/console_orgdetail_1440.png", fullPage: true });
console.log("Screenshot saved. URL:", page.url());

await browser.close();
