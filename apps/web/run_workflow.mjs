import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("request", (req) => { if (req.url().includes("/run") || req.url().includes("/checks")) console.log("[req]", req.method(), req.url()); });
page.on("response", async (res) => {
  if (res.url().includes("/run")) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.log("[res]", res.status(), res.url(), body.slice(0, 1500));
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
await page.getByRole("button", { name: "Run checks", exact: true }).click();
await page.waitForTimeout(6000);
const runBtn = page.getByRole("button", { name: "Run", exact: true });
const disabled = await runBtn.isDisabled().catch(() => true);
console.log(">>> Run button disabled?", disabled);
if (!disabled) {
  await runBtn.click();
  console.log(">>> clicked Run");
  await page.waitForTimeout(8000);
}
await page.screenshot({ path: "/tmp/run-result.png", fullPage: true });
const bodyText = await page.locator('body').innerText();
console.log(">>> BODY:\n", bodyText.slice(0, 2000));
await browser.close();
