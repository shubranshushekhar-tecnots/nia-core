import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', "demo@nia.dev");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }),
  page.locator('button[type="submit"]').first().click(),
]);
await page.goto("http://localhost:3100/app/workflows/bbe6e6ad-97cd-444b-9219-d0020de88d28");
await page.waitForTimeout(1500);
await page.getByText("Supabase (Postgres)", { exact: true }).click();
await page.waitForTimeout(1000);
const drawerText = await page.locator('body').innerText();
console.log(drawerText);
await browser.close();
