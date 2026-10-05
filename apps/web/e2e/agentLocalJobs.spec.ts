import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Same env-loading need as agents.spec.ts/copilot.spec.ts — this process is
 * plain node, never routed through Next's own env loading.
 */
function loadWebEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || !/^[A-Z0-9_]+$/.test(trimmed.slice(0, eq))) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadWebEnv();

test.use({ storageState: personas.canvasA.storageStatePath });

// Matches apps/web/.env.local's AGENT_PLATFORM_URL — the same address the
// real CLI (apps/agent/src/link/pairing.ts, checkInLoop.ts) talks to. This
// spec plays the agent's HTTP contract directly against the real
// agent-bridge (services/agent-bridge/src/app.ts), never spawning the CLI
// process itself — no SQL Server, no agent process, no fake Planometry
// server, just the two real routes a local-CLI agent build actually calls.
const AGENT_BRIDGE_URL = process.env.AGENT_PLATFORM_URL ?? 'http://localhost:4040';

const AGENT_NAME = `e2e-local-jobs-${Date.now()}`;
const JOB_ID = `e2e-job-id-${Date.now()}`;
// Deliberately avoids any substring that collides with reserved UI words
// ("local"/"ok"/"paused"/"failed"/"config") this spec also asserts on, so
// text-based locators below never accidentally cross-match between the job
// row's name cell (which appends a "Local" tag) and a run row's job cell
// (which doesn't).
const JOB_NAME = `e2e-job-name-${Date.now()}`;

function parsePairingCommand(commandText: string): { pairingCodeId: string; code: string; url: string } {
  const raw = commandText.match(/--code\s+(\S+)/)?.[1];
  const url = commandText.match(/--url\s+(\S+)/)?.[1];
  if (!raw || !url) throw new Error(`could not parse pairing command: ${commandText}`);
  const dotIdx = raw.indexOf('.');
  if (dotIdx < 0) throw new Error(`pairing code missing '.' separator: ${raw}`);
  return { pairingCodeId: raw.slice(0, dotIdx), code: raw.slice(dotIdx + 1), url };
}

async function pair(pairingCodeId: string, code: string): Promise<{ agentId: string; agentKey: string }> {
  const res = await fetch(`${AGENT_BRIDGE_URL}/agent-api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCodeId, code }),
  });
  if (!res.ok) throw new Error(`pair failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// noHold: true on every call (not just the "first check-in" the real CLI
// reserves it for) — this spec doesn't exercise the hold/long-poll
// behavior at all, and without it every check-in would block for the
// bridge's ~25s CHECK_IN_HOLD_MS before responding.
async function checkIn(agentKey: string, body: Record<string, unknown>): Promise<{ acknowledgedRunIds: string[] }> {
  const res = await fetch(`${AGENT_BRIDGE_URL}/agent-api/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentKey}` },
    body: JSON.stringify({ noHold: true, ...body }),
  });
  if (!res.ok) throw new Error(`check-in failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Same-origin /api/backend/* proxy (next.config.mjs) requires a real Bearer
// token (apps/api's requireAuth on agentsRouter) — cookies alone 401. The
// page's own client code gets this from /api/auth-token
// (lib/auth/browserSession.ts's ensureBearerToken); reusing that same route
// here via page.request (which carries the storageState's httpOnly cookie)
// gets the same token without duplicating any session logic.
async function fetchSetupsApiText(page: Page, agentId: string): Promise<string> {
  const tokenRes = await page.request.get('/api/auth-token');
  const { token } = (await tokenRes.json()) as { token: string | null };
  const res = await page.request.get(`/api/backend/agents/${agentId}/setups`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.text();
}

/**
 * Slice L4's read-only CLI-job reporting, driven as a real check-in (never
 * through the CLI process) against the real agent-bridge. Companion to
 * agents.spec.ts (which drives the real CLI through add/pair/online/
 * offline/revoke) — this spec covers the local-jobs panel Slice L4 added:
 * job state/error-class display, run accumulation, idempotent resends, the
 * "message" field never reaching storage or the page, and an empty
 * localJobs check-in soft-removing previously reported jobs.
 */
test('local CLI jobs reported via check-in show up, update, and clear on the Agents page', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let agentId: string | null = null;
  let agentKey = '';
  let run2RunId = '';

  try {
    // a) Add an agent, take the pairing command from the UI, pair over HTTP.
    await test.step('a) add agent + pair via /agent-api/pair', async () => {
      await page.goto('/app/agents');
      await page.getByRole('button', { name: 'Add agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add agent' });
      await dialog.locator('#agent-name').fill(AGENT_NAME);
      await dialog.getByRole('button', { name: 'Add agent' }).click();

      const commandLocator = dialog.locator('span', { hasText: 'nia-agent pair --code' });
      await expect(commandLocator).toBeVisible({ timeout: 15_000 });
      const commandText = (await commandLocator.textContent()) ?? '';
      const { pairingCodeId, code } = parsePairingCommand(commandText);
      await dialog.getByRole('button', { name: 'Done' }).click();

      const result = await pair(pairingCodeId, code);
      expect(result.agentId).toMatch(/^[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/);
      expect(result.agentKey.length).toBeGreaterThan(0);
      agentId = result.agentId;
      agentKey = result.agentKey;
    });

    const nameSpan = page.getByText(AGENT_NAME, { exact: true });

    // b) Check in with one ok job + one ok run report (100 rows).
    await test.step('b) check-in: one ok job + one ok run report (100 rows)', async () => {
      const run1 = {
        runId: randomUUID(),
        jobId: JOB_ID,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'ok',
        rowsSent: 100,
        rowsDeleted: 0,
        parts: 1,
      };
      await checkIn(agentKey, {
        localJobs: [
          {
            id: JOB_ID,
            name: JOB_NAME,
            connectionName: 'e2e-connection',
            sourceTable: 'orders',
            destinationType: 'mysql',
            destinationHost: 'localhost',
            mode: 'full',
            state: 'ok',
            consecutiveFailures: 0,
          },
        ],
        runReports: [run1],
      });

      await expect(async () => {
        await page.reload();
        await expect(nameSpan.locator('..').getByText('Online')).toBeVisible();
      }).toPass({ timeout: 60_000 });

      await nameSpan.locator('..').getByRole('button', { name: 'Expand agent jobs' }).click();

      // Job row: the name cell renders `${job.name}` immediately followed
      // by a "Local" tag span, concatenated with no whitespace (AgentsClient.tsx) —
      // filtering a <span> that has both substrings isolates that one cell
      // from a run row's job cell below (which has the name only, no "Local").
      const jobRow = page.locator('span', { hasText: JOB_NAME }).filter({ hasText: 'Local' }).locator('..');
      await expect(jobRow).toBeVisible({ timeout: 10_000 });
      await expect(jobRow).toContainText('ok');

      const runJobCell = page.locator('span', { hasText: JOB_NAME }).filter({ hasNotText: 'Local' });
      await expect(runJobCell).toHaveCount(1);
      const runRow = runJobCell.locator('..');
      await expect(runRow).toContainText('100');
      await expect(runRow).toContainText('ok');
    });

    // c) Check in with the job paused (error class "config") + a failed run;
    // both carry an unknown "message" field that must never surface.
    await test.step('c) check-in: job paused (error class "config") + failed run; "message" never stored/shown', async () => {
      run2RunId = randomUUID();
      const run2 = {
        runId: run2RunId,
        jobId: JOB_ID,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'failed',
        rowsSent: 0,
        rowsDeleted: 0,
        parts: 1,
        message: 'do-not-store-this',
      };
      await checkIn(agentKey, {
        localJobs: [
          {
            id: JOB_ID,
            name: JOB_NAME,
            connectionName: 'e2e-connection',
            sourceTable: 'orders',
            destinationType: 'mysql',
            destinationHost: 'localhost',
            mode: 'full',
            state: 'paused',
            errorClass: 'config',
            consecutiveFailures: 1,
            message: 'do-not-store-this',
          },
        ],
        runReports: [run2],
      });

      await page.reload();
      await nameSpan.locator('..').getByRole('button', { name: 'Expand agent jobs' }).click();

      const jobRow = page.locator('span', { hasText: JOB_NAME }).filter({ hasText: 'Local' }).locator('..');
      await expect(jobRow).toBeVisible({ timeout: 10_000 });
      await expect(jobRow).toContainText('paused (config)');

      const runJobCell = page.locator('span', { hasText: JOB_NAME }).filter({ hasNotText: 'Local' });
      await expect(runJobCell).toHaveCount(2);

      await expect(page.locator('body')).not.toContainText('do-not-store-this');
      const apiText = await fetchSetupsApiText(page, agentId!);
      expect(apiText).not.toContain('do-not-store-this');
    });

    // d) Resend the same failed run report (same runId) — must stay idempotent.
    await test.step('d) resend the same failed run report: still exactly two runs', async () => {
      const run2Resend = {
        runId: run2RunId,
        jobId: JOB_ID,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'failed',
        rowsSent: 0,
        rowsDeleted: 0,
        parts: 1,
      };
      await checkIn(agentKey, { runReports: [run2Resend] });

      await page.reload();
      await nameSpan.locator('..').getByRole('button', { name: 'Expand agent jobs' }).click();

      const runJobCell = page.locator('span', { hasText: JOB_NAME }).filter({ hasNotText: 'Local' });
      await expect(runJobCell).toHaveCount(2);
    });

    // e) Check in with an empty job list — succeeds, job disappears, agent stays online.
    await test.step('e) check-in with empty localJobs: job disappears, agent stays online', async () => {
      await checkIn(agentKey, { localJobs: [] });

      await page.reload();
      await expect(nameSpan.locator('..').getByText('Online')).toBeVisible();
      await nameSpan.locator('..').getByRole('button', { name: 'Expand agent jobs' }).click();

      await expect(page.getByText('No local jobs reported by this agent yet.')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('span', { hasText: JOB_NAME })).toHaveCount(0);
    });
  } finally {
    if (agentId) {
      await pool.query('delete from public.platform_agents where id = $1', [agentId]);
    }
    await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
    await pool.end();
  }
});
