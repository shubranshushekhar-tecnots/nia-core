import { chromium } from "@playwright/test";
import fs from "node:fs";

const email = "demo@nia.dev";
const password = "password";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);
await page.waitForTimeout(500);
console.log("URL after login:", page.url());
if (!page.url().includes("/app")) {
  console.log("BODY TEXT SNIPPET:", (await page.textContent("body")).slice(0, 500));
}

const cookies = await page.context().cookies();
fs.writeFileSync("/tmp/demo_cookies.json", JSON.stringify(cookies, null, 2));
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
fs.writeFileSync("/tmp/demo_cookie_header.txt", cookieHeader);
console.log("cookie header written to /tmp/demo_cookie_header.txt");

await browser.close();
