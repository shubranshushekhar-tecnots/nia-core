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
const { token, keys } = await page.evaluate(() => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  for (const k of keys) {
    if (k && (k.includes("auth-token") || k.startsWith("sb-"))) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v && v.access_token) return { token: v.access_token, keys };
        if (v && v.currentSession && v.currentSession.access_token) return { token: v.currentSession.access_token, keys };
      } catch {}
    }
  }
  return { token: null, keys };
});
console.log("KEYS:", keys.join(","));
console.log("TOKEN:", token);
await browser.close();
