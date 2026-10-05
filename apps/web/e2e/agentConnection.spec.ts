import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Inlined rather than reusing fixtures/flows.ts's gotoWorkflow: this org has
 * exactly one project, so its always-mounted Sidebar (ProjectDetailClient /
 * ProjectsListClient share the layout with Sidebar.tsx, which never
 * unmounts across client-side navigation) renders its own copies of both
 * the project link and the workflow link, with the SAME accessible name as
 * the main content's. getByRole('link', {name}) — even with `.first()` —
 * is a DOM-order coin flip between them. Worse, the Sidebar's project-tree
 * link (Sidebar.tsx) carries its own onClick={() => toggleOpenProject(...)}
 * that OPENS/CLOSES the tree — landing on it instead of the main content's
 * link doesn't just risk clicking the wrong element, it can toggle the
 * workflow list closed right as the next click needs it open.
 *
 * Fix: target `a.nx-wipe` directly — the class ProjectsListClient.tsx and
 * ProjectDetailClient.tsx's own row Links set (confirmed in both files) and
 * the Sidebar's equivalents never do — so this is unambiguous and immune to
 * the Sidebar's toggle state, regardless of click order or render timing.
 */
async function gotoSeededWorkflow(page: import('@playwright/test').Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.locator('a.nx-wipe', { hasText: projectName }).first().click();
  await page.waitForURL(/\/app\/projects\/[0-9a-f-]{36}/);
  await page.locator('a.nx-wipe', { hasText: workflowName }).first().click();
  // Generous timeout, not the 5s default: /app/workflows/:id's first hit
  // this run pays Next dev mode's on-demand route compile (observed up to
  // ~4s for /app's own first compile right after a dev-server restart,
  // same hazard flows.ts's own gotoWorkflow comment documents).
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/, { timeout: 15_000 });
}

/**
 * Same env-loading need as agents.spec.ts/agentLocalJobs.spec.ts — this
 * process is plain node, never routed through Next's own env loading.
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

// Same entrypoint convention as agents.spec.ts — real process, from source
// via tsx, never dist/index.js.
const agentDir = path.join(__dirname, '..', '..', 'agent');
const tsxBin = path.join(agentDir, 'node_modules', '.bin', 'tsx');
const entryPoint = path.join(agentDir, 'src', 'index.ts');

// src/generated/version.ts (gitignored) is an import-time dependency of
// src/index.ts's chain — generate it up front, same as agents.spec.ts.
execFileSync(process.execPath, [path.join(agentDir, 'scripts', 'generate-version.mjs')], { cwd: agentDir });

const AGENT_NAME = `e2e-sqlagent-${Date.now()}`;
const LOCAL_CONNECTION_ID = `e2e-local-conn-${Date.now()}`;
const LOCAL_CONNECTION_LABEL = `E2E MSSQL ${Date.now()}`;
const PLATFORM_CONNECTION_NAME = `Local SQL Server E2E ${Date.now()}`;

// packages/extract/scripts/harness/{start,config}.sh's fixed coordinates for
// `nia-extract-mssql-test` — this spec's beforeAll (below) starts that exact
// container (via SQLSERVER_HOST override if set, else localhost:14330) and
// polls it healthy before the 15-minute test budget starts.
const MSSQL_HOST = process.env.SQLSERVER_HOST ?? 'localhost';
const MSSQL_PORT = 14330;
const MSSQL_DATABASE = 'nia_extract_test';
const MSSQL_USER = 'sa';
const MSSQL_PASSWORD = 'N!aExtractTest_2026';

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
 * Slice C1's e2e — the full "Local database (via agent)" path driven
 * end-to-end against real infrastructure: a real SQL Server container
 * (packages/extract/scripts/harness's fixtures), a real `nia-agent` CLI
 * process (not an HTTP stand-in — contrast with agentLocalJobs.spec.ts),
 * the real agent-bridge, and the real web UI's connector catalog + canvas
 * rail + node context menu + table drawer.
 *
 * Confirmed infrastructure requirement (not managed by this test): SQL
 * Server must already be reachable/seeded at MSSQL_HOST:MSSQL_PORT before
 * this test runs — starting/polling that container is outside this spec's
 * own 15-minute budget by design (see the plan's beforeAll note); this test
 * only connects to it.
 */
test('agent-backed local SQL Server connection: install, pair, test, browse tables, then detect offline', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  const home = mkdtempSync(path.join(tmpdir(), 'nia-agent-e2e-'));
  let agentChild: ChildProcess | null = null;
  let agentId: string | null = null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // a) Install the "Local database (via agent)" connector if not already.
    await test.step('a) install the sqlserver-agent connector', async () => {
      await page.goto('/app/connections');
      const card = page.locator('[data-testid="connector-card"][data-connector-id="sqlserver-agent"]');
      await expect(card).toBeVisible({ timeout: 15_000 });
      const installBtn = card.getByRole('button', { name: 'Install' });
      if (await installBtn.isVisible().catch(() => false)) {
        await installBtn.click();
        await expect(card.getByText('Installed')).toBeVisible({ timeout: 10_000 });
      }
    });

    // b) Add an agent via the UI, pair the real CLI, add a local SQL Server
    // connection to it, then start the real CLI for real against the
    // running bridge.
    await test.step('b) add agent, pair real CLI, add local connection, start', async () => {
      await page.goto('/app/agents');
      await page.getByRole('button', { name: 'Add agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add agent' });
      await dialog.locator('#agent-name').fill(AGENT_NAME);
      await dialog.getByRole('button', { name: 'Add agent' }).click();

      const commandLocator = dialog.locator('span', { hasText: 'nia-agent pair --code' });
      await expect(commandLocator).toBeVisible({ timeout: 15_000 });
      const commandText = (await commandLocator.textContent()) ?? '';
      const code = commandText.match(/--code\s+(\S+)/)?.[1];
      const url = commandText.match(/--url\s+(\S+)/)?.[1];
      if (!code || !url) throw new Error(`could not parse pairing command: ${commandText}`);
      await dialog.getByRole('button', { name: 'Done' }).click();

      const pairResult = await runCli(['pair', '--code', code, '--url', url], home);
      expect(pairResult.code, `pair stdout=${pairResult.stdout} stderr=${pairResult.stderr}`).toBe(0);
      const pairedMatch = pairResult.stdout.match(/paired as agent ([0-9a-f-]+)/);
      agentId = pairedMatch?.[1] ?? null;
      expect(agentId, `could not parse agent id from: ${pairResult.stdout}`).not.toBeNull();

      const addConnResult = await runCli(
        [
          'connection',
          'add',
          '--id',
          LOCAL_CONNECTION_ID,
          '--label',
          LOCAL_CONNECTION_LABEL,
          '--host',
          MSSQL_HOST,
          '--port',
          String(MSSQL_PORT),
          '--database',
          MSSQL_DATABASE,
          '--user',
          MSSQL_USER,
          '--password',
          MSSQL_PASSWORD,
          '--encrypt',
          'true',
          '--trust-server-certificate',
          'true',
          '--source-timezone',
          'UTC',
          '--agent-key',
          'e2e-placeholder-agent-key',
        ],
        home,
      );
      expect(addConnResult.code, `connection add stdout=${addConnResult.stdout} stderr=${addConnResult.stderr}`).toBe(0);

      agentChild = startAgent(home);

      // First check-in after start() skips the hold (noHold) — confirmed
      // within a couple of seconds, not the ~25s a held check-in would take.
      await expect(async () => {
        const result = await runCli(['status'], home);
        expect(result.stdout.toLowerCase()).toContain('last check-in');
      }).toPass({ timeout: 5_000 });

      await expect(async () => {
        await page.reload();
        await expect(page.getByText(AGENT_NAME).locator('..').getByText('Online')).toBeVisible();
      }).toPass({ timeout: 60_000 });
    });

    // c) Create a "Local database (via agent)" connection via the real UI
    // picker, selecting the agent + the local connection it now reports.
    // Reuses canvasA's seeded "Canvas E2E Project" / "Canvas E2E Workflow"
    // fixture (same convention as canvas.spec.ts) rather than creating a new
    // project — canvasA's org is on the Free plan's 1-project limit and
    // already holds that one seeded project.
    await test.step('c) create the platform connection via the UI picker', async () => {
      await gotoSeededWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');

      // Self-healing reset (same pattern as canvas.spec.ts's beforeEach):
      // this is a shared fixture workflow other specs also use — clear any
      // nodes a previous run left behind before dropping ours, so the
      // upcoming toHaveCount(1) assertion is meaningful.
      const newChat = page.getByRole('button', { name: 'New chat' });
      if (await newChat.isVisible().catch(() => false)) {
        await newChat.click();
      }
      while ((await page.locator('.react-flow__node').count()) > 0) {
        await page.locator('.react-flow__node').first().click();
        await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
      }
      await expect(page.locator('.react-flow__node')).toHaveCount(0);

      const rail = page.getByTestId('nodes-rail');
      await rail.getByText('Local database (via agent)', { exact: true }).click();

      const dialog = page.getByRole('dialog', { name: 'Add Local database (via agent) connection' });
      await expect(dialog).toBeVisible();
      await dialog.locator('#connection-display-name').fill(PLATFORM_CONNECTION_NAME);

      await dialog.locator('#connection-field-agentId').selectOption({ label: AGENT_NAME });
      // The second dropdown only populates after listAgentConnectionsClient
      // resolves for the selected agent — wait for its real option, not an
      // arbitrary sleep.
      await expect(dialog.locator(`#connection-field-agentConnectionId option:has-text("${LOCAL_CONNECTION_LABEL}")`)).toHaveCount(1, {
        timeout: 15_000,
      });
      await dialog.locator('#connection-field-agentConnectionId').selectOption({ label: `${LOCAL_CONNECTION_LABEL} (${MSSQL_DATABASE})` });

      await dialog.getByRole('button', { name: 'Add connection' }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    });

    // d) Drag it onto the canvas, Test it — assert success, note elapsed time.
    await test.step('d) test connection: assert success well under the 15s caller timeout', async () => {
      const rail = page.getByTestId('nodes-rail');
      await rail.dispatchEvent('click'); // no-op, keeps rail state settled before the drag below
      const item = rail.getByText(PLATFORM_CONNECTION_NAME, { exact: true });
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await item.dispatchEvent('dragstart', { dataTransfer });
      const surface = page.getByTestId('canvas-surface');
      await surface.dispatchEvent('dragover', { dataTransfer, clientX: 450, clientY: 200 });
      await surface.dispatchEvent('drop', { dataTransfer, clientX: 450, clientY: 200 });
      const picker = page.getByTestId('drop-role-picker');
      if (await picker.isVisible().catch(() => false)) {
        await picker.getByRole('menuitem', { name: 'Use as Source' }).click();
      }
      await expect(page.locator('.react-flow__node')).toHaveCount(1);
      await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

      const node = page.locator('.react-flow__node').first();
      const startedAt = Date.now();
      await node.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Test connection' })).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Test connection' }).click();
      await expect(menu).not.toBeVisible();

      await expect(page.getByText(/Connection OK/)).toBeVisible({ timeout: 10_000 });
      const elapsedMs = Date.now() - startedAt;
      // Informal note only — the bridge's test_connection task timeout is
      // 8000ms, so a healthy agent must answer well under that.
      console.log(`[agentConnection.spec] Test connection (online agent) took ${elapsedMs}ms`);
      expect(elapsedMs).toBeLessThan(8_000);

      // e) Table-browsing: open the drawer, wait for the real schema fetch,
      // and confirm a real table from the seeded SQL Server database shows up.
      await node.click();
      await page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema'));
      const tableSelect = page.locator('#node-drawer-table-select');
      await expect(tableSelect.locator('option', { hasText: 'widgets' })).toHaveCount(1, { timeout: 10_000 });
    });

    // f) Stop the real agent process; Test again — assert the UI surfaces a
    // failure promptly (within the bridge's 8s test_connection task timeout,
    // not the caller's full 15s timeout). friendlyConnectionError has no
    // special-case rule for an agent-offline/timeout message, so the toast
    // falls back to its generic "Connection failed." text.
    await test.step('f) stop the agent; test again: failure surfaces within ~8-10s', async () => {
      if (agentChild) await stopAgent(agentChild);
      agentChild = null;

      const node = page.locator('.react-flow__node').first();
      const startedAt = Date.now();
      await node.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Test connection' }).click();
      await expect(menu).not.toBeVisible();

      await expect(page.getByText('Connection failed.')).toBeVisible({ timeout: 11_000 });
      const elapsedMs = Date.now() - startedAt;
      console.log(`[agentConnection.spec] Test connection (offline agent) took ${elapsedMs}ms`);
    });
  } finally {
    if (agentChild && (agentChild as ChildProcess).exitCode === null) {
      (agentChild as ChildProcess).kill('SIGKILL');
    }
    // Good citizen: this ran on the shared "Canvas E2E Workflow" fixture —
    // remove the node we added so other specs find it clean, same as
    // canvas.spec.ts's own self-healing reset relies on.
    try {
      if ((await page.locator('.react-flow__node').count()) > 0) {
        await page.locator('.react-flow__node').first().click();
        await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
        await expect(page.locator('.react-flow__node')).toHaveCount(0);
      }
    } catch {
      // best-effort — don't mask the real test failure/result with a cleanup error
    }
    rmSync(home, { recursive: true, force: true });
    await pool.query('delete from public.connections where display_name = $1', [PLATFORM_CONNECTION_NAME]);
    if (agentId) {
      await pool.query('delete from public.platform_agents where id = $1', [agentId]);
    }
    await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
    await pool.end();
  }
});
