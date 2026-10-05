import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Same env-loading need as copilot.spec.ts — this process is plain node,
 * never routed through Next's own env loading.
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

// Same entrypoint as apps/agent/src/cli/cliStartup.test.ts ("real process,
// same entrypoint as `pnpm run dev`") — run from source via tsx, never
// dist/index.js, so this spec never masks a from-source regression behind
// a stale build. agentDir = apps/agent, two levels up from apps/web/e2e/.
const agentDir = path.join(__dirname, '..', '..', 'agent');
const tsxBin = path.join(agentDir, 'node_modules', '.bin', 'tsx');
const entryPoint = path.join(agentDir, 'src', 'index.ts');

// src/generated/version.ts (gitignored, see .gitignore's comment) is an
// import-time dependency of src/index.ts's chain — generate it up front,
// exactly as apps/agent's own "dev"/"test" package scripts do
// (`generate-version && tsx ...`), so a fresh checkout doesn't crash on
// the very first spawn below.
execFileSync(process.execPath, [path.join(agentDir, 'scripts', 'generate-version.mjs')], { cwd: agentDir });

const AGENT_NAME = `e2e-agent-${Date.now()}`;

// Matches apps/api/src/services/agents.ts:15's ONLINE_THRESHOLD_MS — the
// Agents page only flips an agent to "Offline" once Date.now() minus its
// last check-in exceeds this, so waiting any less here is a guaranteed
// flake, not a real signal. +30s of margin for this process's own
// stop-agent-to-page-poll round trip.
const OFFLINE_WAIT_MS = 90_000 + 30_000;

function runCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin, [entryPoint, ...args], {
      cwd: agentDir,
      env: { ...process.env, NIA_AGENT_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function startAgent(home: string): ChildProcess {
  return spawn(tsxBin, [entryPoint, 'start'], {
    cwd: agentDir,
    env: { ...process.env, NIA_AGENT_HOME: home },
  });
}

function stopAgent(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

/**
 * Part 2 of the agent-canvas-integration L3 follow-up — pairs and drives a
 * real nia-agent CLI child process against the real agent-bridge/api/web
 * dev stack, asserting the Agents page reflects online/offline/revoked
 * status. Uses a throwaway NIA_AGENT_HOME so this never touches a real
 * operator's paired state.
 */
test('add, pair, and revoke a real agent end to end', async ({ page }) => {
  // Local-only override (not the global playwright.config.ts timeout):
  // this single test's steps b/c/d each poll for up to OFFLINE_WAIT_MS
  // (below) in sequence, which alone exceeds Playwright's 30s default.
  test.setTimeout(5 * 60 * 1000);

  const home = mkdtempSync(path.join(tmpdir(), 'nia-agent-e2e-'));
  let agentChild: ChildProcess | null = null;
  let agentId: string | null = null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // a) Add an agent with a name; confirm the pairing command is shown once.
    await page.goto('/app/agents');
    await page.getByRole('button', { name: 'Add agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add agent' });
    await dialog.locator('#agent-name').fill(AGENT_NAME);
    await dialog.getByRole('button', { name: 'Add agent' }).click();

    const commandLocator = dialog.locator('span', { hasText: 'nia-agent pair --code' });
    await expect(commandLocator).toBeVisible({ timeout: 15_000 });
    const commandText = (await commandLocator.textContent()) ?? '';
    expect(commandText.match(/nia-agent pair --code/g)?.length ?? 0).toBe(1);

    const code = commandText.match(/--code\s+(\S+)/)?.[1];
    const url = commandText.match(/--url\s+(\S+)/)?.[1];
    if (!code || !url) throw new Error(`could not parse pairing command: ${commandText}`);
    expect(code).toContain('.');

    await dialog.getByRole('button', { name: 'Done' }).click();

    // b) Pair + start the real CLI; confirm the agent shows online within 60s.
    const pairResult = await runCli(['pair', '--code', code, '--url', url], home);
    expect(pairResult.code, `pair stdout=${pairResult.stdout} stderr=${pairResult.stderr}`).toBe(0);
    const pairedMatch = pairResult.stdout.match(/paired as agent ([0-9a-f-]+)/);
    agentId = pairedMatch?.[1] ?? null;

    agentChild = startAgent(home);

    // The first check-in after start() asks the bridge to skip its hold
    // (services/agent-bridge/src/app.ts's noHold) so this is confirmed
    // within a couple of seconds, not the ~25s a held check-in would take.
    await expect(async () => {
      const result = await runCli(['status'], home);
      expect(result.stdout.toLowerCase()).toContain('last check-in');
    }).toPass({ timeout: 5_000 });

    const row = page.locator('div', { has: page.locator(`text="${AGENT_NAME}"`) }).last();
    await page.reload();
    await expect(page.getByText(AGENT_NAME).locator('..').getByText('Online')).toBeVisible({ timeout: 60_000 });

    // c) Stop the agent; confirm the list shows it offline.
    if (agentChild) await stopAgent(agentChild);
    agentChild = null;
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(AGENT_NAME).locator('..').getByText('Offline')).toBeVisible();
    }).toPass({ timeout: OFFLINE_WAIT_MS });

    // d) Start it again, then revoke it on the page; confirm `agent status`
    // shows revoked, and the process is still running (not killed by revoke).
    agentChild = startAgent(home);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(AGENT_NAME).locator('..').getByText('Online')).toBeVisible();
    }).toPass({ timeout: 60_000 });

    const agentRow = page.locator('div', { hasText: AGENT_NAME }).filter({ has: page.getByRole('button', { name: 'Revoke' }) });
    await agentRow.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).last().click();
    // Revoked agents stay in the list (revoke_agent only flips status to
    // 'revoked' — see apps/api/src/services/agents.ts's revokeAgent, it
    // never deletes the row) but flip to "Revoked". AgentsClient.tsx now
    // refreshes immediately on a successful revoke instead of waiting for
    // its own 15s poll, so this must resolve well within 5s, no reload.
    await expect(page.getByText(AGENT_NAME).locator('..').getByText('Revoked')).toBeVisible({ timeout: 5_000 });

    // An agent mid-held check-in only learns of the revoke at its *next*
    // check-in (the current one already read 'active' before the revoke
    // landed) — so this can take up to ~CHECK_IN_HOLD_MS (25s) plus a
    // round trip, not the few seconds a noHold check-in gets. 45s margin.
    await expect(async () => {
      const result = await runCli(['status'], home);
      expect(result.stdout.toLowerCase()).toContain('revoked');
    }).toPass({ timeout: 45_000 });

    expect(agentChild.exitCode, 'agent process must still be running after revoke').toBeNull();
  } finally {
    if (agentChild && agentChild.exitCode === null) {
      agentChild.kill('SIGKILL');
    }
    rmSync(home, { recursive: true, force: true });
    if (agentId) {
      await pool.query('delete from public.platform_agents where id = $1', [agentId]);
    }
    await pool.query(
      `delete from public.agent_pairing_codes where display_name = $1`,
      [AGENT_NAME],
    );
    await pool.end();
  }
});
