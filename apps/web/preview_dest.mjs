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
const cookies = await page.context().cookies();
const authCookie = cookies.find((c) => c.name.includes("auth-token") && !c.name.includes("code-verifier"));
let accessToken = null;
if (authCookie) {
  try {
    let raw = decodeURIComponent(authCookie.value);
    if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    accessToken = parsed.access_token ?? (Array.isArray(parsed) ? parsed[0] : null);
  } catch (e) {
    console.log("parse error", e.message, authCookie.value.slice(0, 100));
  }
}
console.log("cookie names:", cookies.map((c) => c.name).join(","));
console.log("accessToken found:", !!accessToken);

const result = await page.evaluate(async (token) => {
  const res = await fetch("/api/backend/workflows/c06ce443-b1f6-45d1-9192-b3de6c898535/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ destNodeId: "4df383d0-2c29-423c-8150-3f7b8ab9fc11" }),
  });
  const text = await res.text();
  return { status: res.status, text };
}, accessToken);
console.log(JSON.stringify(result, null, 2));
await browser.close();
