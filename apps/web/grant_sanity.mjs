import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";

const email = "demo@nia.dev";
const password = "password";
const workflowId = "bbe6e6ad-97cd-444b-9219-d0020de88d28"; // "ETL kill-resume smoke"

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log("[browser]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("response", async (res) => {
  const url = res.url();
  const method = res.request().method();
  if ((url.includes("/checks") || url.includes("/run")) && method === "POST") {
    const status = res.status();
    const body = await res.text().catch(() => "<unreadable>");
    console.log(`[net] ${method} ${url} ->`, status, body.slice(0, 2000));
  }
});

await page.goto("http://localhost:3100/login");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }),
  page.locator('button[type="submit"]').first().click(),
]);
console.log("STEP: logged in, url =", page.url());

await page.goto(`http://localhost:3100/app/workflows/${workflowId}`);
await page.waitForTimeout(1500);
console.log("STEP: canvas loaded, url =", page.url());
await page.screenshot({ path: "/tmp/grant-sanity-1-canvas.png" });

// Click the destination node card on the canvas to open NodeDrawer.
await page.getByText("Supabase (Postgres)", { exact: true }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/grant-sanity-2-drawer.png" });
console.log("STEP: clicked dest node");

// GrantAccessPanel unmounts entirely once grantCovers is true (NodeDrawer.tsx
// !grantCovers gate) — it never shows a persistent "Confirmed." state. So
// detect "already granted" by the panel's mint button being absent instead.
const grantBtnCount = await page.getByRole("button", { name: /grant write access/i }).count();
if (grantBtnCount === 0) {
  console.log("STEP: grant panel not present (grantCovers already true from a prior run) — skipping mint/confirm.");
} else {
  const grantBtn = page.getByRole("button", { name: /grant write access/i });
  await grantBtn.waitFor({ state: "visible", timeout: 10000 });
  console.log("STEP: Grant write access button visible");
  await grantBtn.click();

  const statementPre = page.locator("pre");
  await statementPre.waitFor({ state: "visible", timeout: 10000 });
  const statementText = await statementPre.textContent();
  console.log("STEP: statement text shown:\n", statementText);
  await page.screenshot({ path: "/tmp/grant-sanity-3-statement.png" });

  // Parse role user + password out of the CREATE ROLE statement.
  const roleMatch = statementText.match(/CREATE ROLE "([^"]+)" WITH LOGIN PASSWORD '([^']+)'/);
  if (!roleMatch) throw new Error("Could not parse CREATE ROLE statement from: " + statementText);
  const [, roleUser] = roleMatch;
  console.log("STEP: parsed role:", roleUser);

  // Actually run the statement against the real destination DB (dev-postgres sandbox, host port 5433).
  execSync(
    `PGPASSWORD=devroot psql -h localhost -p 5433 -U postgres -d sandbox -v ON_ERROR_STOP=1 -c "${statementText.replace(/"/g, '\\"')}"`,
    { shell: "/bin/bash", stdio: "inherit" }
  );
  console.log("STEP: ran grant statement against real destination DB");

  const confirmBtn = page.getByRole("button", { name: /confirm access/i });
  await confirmBtn.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/grant-sanity-4-confirmed.png" });

  const confirmedText = await page.getByText("Confirmed.", { exact: true }).count();
  console.log("STEP: 'Confirmed.' visible:", confirmedText > 0);
}

// Check the write verb (insert) is no longer locked.
const lockedBadges = await page.getByText("Needs write grant", { exact: true }).count();
console.log("STEP: remaining 'Needs write grant' badges in drawer:", lockedBadges);

// Close the drawer, then run checks + run the workflow for real.
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(300);

const runChecksBtn = page.getByRole("button", { name: "Run checks", exact: true });
await runChecksBtn.click();
console.log("STEP: clicked Run checks");
await page.waitForFunction(
  () => !document.body.innerText.includes("Running checks"),
  { timeout: 20000 }
).catch(() => console.log("STEP: WARNING — checks still running after 20s timeout"));
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/grant-sanity-5-checks.png" });
const checksText = await page.locator('body').innerText();
console.log("STEP: checks panel text snippet:\n", checksText.slice(checksText.indexOf("Checks"), checksText.indexOf("Checks") + 1200));

const runBtn = page.getByRole("button", { name: "Run", exact: true });
const runDisabled = await runBtn.isDisabled().catch(() => true);
console.log("STEP: Run button disabled?", runDisabled);
if (!runDisabled) {
  await runBtn.click();
  console.log("STEP: clicked Run");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "/tmp/grant-sanity-6-run.png" });
} else {
  await page.screenshot({ path: "/tmp/grant-sanity-6-run-disabled.png" });
}

await browser.close();
console.log("DONE");
