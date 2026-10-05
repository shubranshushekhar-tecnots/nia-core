import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Route 2 e2e — Agent-Canvas integration, slices R1-R5b end to end: a real
 * `nia-agent` CLI process publishes/applies/rejects a Canvas-derived
 * AgentJobSetup against a real (fake) Planometry push server, and carries
 * out run_now/pause/resume actions delivered from the platform.
 *
 * Same style/helpers as agentConnection.spec.ts (gotoSeededWorkflow,
 * loadWebEnv, runCli/startAgent/stopAgent, the SQL Server harness). New
 * here: a second real child process (apps/agent's fake Planometry push
 * server, started exactly as apps/agent's own tests start it — never
 * imported into this process) and the Canvas's agent-delivery-specific UI
 * (AgentSourceColumnsPanel / AgentDeliverySection / MappingEditor /
 * AgentPublishDialog / AgentJobPanel).
 */
async function gotoSeededWorkflow(page: import('@playwright/test').Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.locator('a.nx-wipe', { hasText: projectName }).first().click();
  await page.waitForURL(/\/app\/projects\/[0-9a-f-]{36}/);
  await page.locator('a.nx-wipe', { hasText: workflowName }).first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/, { timeout: 15_000 });
}

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

const agentDir = path.join(__dirname, '..', '..', 'agent');
const tsxBin = path.join(agentDir, 'node_modules', '.bin', 'tsx');
const entryPoint = path.join(agentDir, 'src', 'index.ts');
const fakePlanometryEntryPoint = path.join(agentDir, 'src', 'testing', 'runFakePlanometryServer.ts');

execFileSync(process.execPath, [path.join(agentDir, 'scripts', 'generate-version.mjs')], { cwd: agentDir });

const AGENT_NAME = `e2e-agentdelivery-${Date.now()}`;
const LOCAL_CONNECTION_ID = `e2e-ad-local-conn-${Date.now()}`;
const LOCAL_CONNECTION_LABEL = `E2E AD MSSQL ${Date.now()}`;
const SOURCE_CONNECTION_NAME = `Local SQL Server AD E2E ${Date.now()}`;
const DEST_CONNECTION_NAME = `Planometry AD E2E ${Date.now()}`;

// packages/extract/scripts/harness/{start,config}.sh's fixed coordinates.
const MSSQL_HOST = process.env.SQLSERVER_HOST ?? 'localhost';
const MSSQL_PORT = 14330;
const MSSQL_DATABASE = 'nia_extract_test';
const MSSQL_USER = 'sa';
const MSSQL_PASSWORD = 'N!aExtractTest_2026';

// Deliberately not apps/agent/src/testing's own defaults (4455/4456) — a
// human may be running those manually; use a dedicated pair for this spec.
const FAKE_PLANOMETRY_PORT = 4655;
const FAKE_PLANOMETRY_CONTROL_PORT = 4656;
const FAKE_PLANOMETRY_BASE_URL = `http://127.0.0.1:${FAKE_PLANOMETRY_PORT}`;
const FAKE_PLANOMETRY_CONTROL_URL = `http://127.0.0.1:${FAKE_PLANOMETRY_CONTROL_PORT}`;
const FAKE_TABLE_NAME = 'widgets_dest';

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
 * Starts apps/agent's fake Planometry push+control server as a real child
 * process (never imported) and resolves once both of its own startup log
 * lines appear — the same readiness signal a human watching its stdout
 * would use, not an arbitrary sleep.
 */
function startFakePlanometryServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // `detached: true` makes this child its own process group leader —
    // tsx's CLI re-spawns (rather than exec-replaces) into a second, inner
    // node process carrying the actual loader flags (confirmed via `ps`:
    // the running command is the inner `node --require tsx/preflight
    // --import tsx/loader runFakePlanometryServer.ts`, a different PID from
    // the one `spawn()` returns here), so a plain `child.kill()` on only
    // the outer PID leaves that inner process running, orphaned (reparented
    // to PID 1) once the outer one dies. Killing the whole group (negative
    // PID, see stopFakePlanometryServer) reaches the inner process too.
    const child = spawn(tsxBin, [fakePlanometryEntryPoint], {
      cwd: agentDir,
      detached: true,
      env: {
        ...process.env,
        NIA_AGENT_FAKE_PLANOMETRY_PORT: String(FAKE_PLANOMETRY_PORT),
        NIA_AGENT_FAKE_CONTROL_PORT: String(FAKE_PLANOMETRY_CONTROL_PORT),
      },
    });
    let sawPush = false;
    let sawControl = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('fake Planometry server did not report ready within 15s'));
      }
    }, 15_000);
    const check = () => {
      if (sawPush && sawControl && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', (d) => {
      const text = d.toString();
      if (text.includes('push API listening')) sawPush = true;
      if (text.includes('control API listening')) sawControl = true;
      check();
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`fake Planometry server exited early with code ${code}`));
      }
    });
  });
}

function stopFakePlanometryServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    // Negative PID = kill the whole process group (see startFakePlanometryServer's
    // `detached: true` comment) — reaches the inner, actually-listening node
    // process tsx's CLI re-spawns, not just the outer wrapper `child` points at.
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // Group (or process) already gone — nothing left to kill.
      resolve();
    }
  });
}

async function createFakeTable(): Promise<{ tableId: string; tableUrl: string; pushKey: string }> {
  const res = await fetch(`${FAKE_PLANOMETRY_CONTROL_URL}/create-table`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: FAKE_TABLE_NAME,
      columns: [
        { name: 'id', type: 'Number', isKey: true },
        { name: 'name', type: 'Text', isKey: false },
        { name: 'price', type: 'Number', isKey: false },
      ],
    }),
  });
  if (!res.ok) throw new Error(`create-table failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getFakeTableRows(tableId: string): Promise<unknown[]> {
  const res = await fetch(`${FAKE_PLANOMETRY_CONTROL_URL}/rows?tableId=${encodeURIComponent(tableId)}`);
  if (!res.ok) throw new Error(`rows fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.rows;
}

test.describe('Route 2: agent-delivered Canvas workflow', () => {
  // packages/extract/scripts/harness/start.sh boots+seeds+polls the SQL
  // Server container healthy BEFORE the test's own 20-minute budget starts
  // — this is a beforeAll hook, extended past Playwright's 30s default hook
  // timeout (no global override in playwright.config.ts).
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    execFileSync(path.join(agentDir, '..', '..', 'packages', 'extract', 'scripts', 'harness', 'start.sh'), [], {
      cwd: path.join(agentDir, '..', '..', 'packages', 'extract', 'scripts', 'harness'),
      stdio: 'inherit',
    });
  });

  test('agent-delivered workflow: publish, run now, change filter, pause/resume, allow-list rejection', async ({ page }) => {
    test.setTimeout(20 * 60 * 1000);

    const home = mkdtempSync(path.join(tmpdir(), 'nia-agent-e2e-ad-'));
    let agentChild: ChildProcess | null = null;
    let fakeServerChild: ChildProcess | null = null;
    let agentId: string | null = null;
    let fakeTableId: string | null = null;
    let fakeHost: string | null = null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
      // a) Pair a real agent, add its one local SQL Server connection, start
      // the fake Planometry server, and allow-list its host.
      await test.step('a) pair agent, add local connection, start fake Planometry server, allow-list its host', async () => {
        fakeServerChild = await startFakePlanometryServer();
        const fakeTable = await createFakeTable();
        fakeTableId = fakeTable.tableId;

        await page.goto('/app/connections');
        for (const connectorId of ['sqlserver-agent', 'planometry-table']) {
          const card = page.locator(`[data-testid="connector-card"][data-connector-id="${connectorId}"]`);
          await expect(card).toBeVisible({ timeout: 15_000 });
          // `exact: true` matters: an already-installed card's button is named
          // "Uninstall", which contains "Install" as a substring and would
          // otherwise match here too, opening the uninstall-confirmation modal
          // instead of skipping (observed hanging the whole step on a stray
          // leftover-installed connector from an earlier run).
          const installBtn = card.getByRole('button', { name: 'Install', exact: true });
          if (await installBtn.isVisible().catch(() => false)) {
            await installBtn.click();
            await expect(card.getByText('Installed')).toBeVisible({ timeout: 10_000 });
          }
        }

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

        fakeHost = new URL(fakeTable.tableUrl).host;
        const allowResult = await runCli(['destinations', 'allow', fakeHost], home);
        expect(allowResult.code, `destinations allow stdout=${allowResult.stdout} stderr=${allowResult.stderr}`).toBe(0);

        agentChild = startAgent(home);
        await expect(async () => {
          const result = await runCli(['status'], home);
          expect(result.stdout.toLowerCase()).toContain('last check-in');
        }).toPass({ timeout: 5_000 });

        await expect(async () => {
          await page.reload();
          await expect(page.getByText(AGENT_NAME).locator('..').getByText('Online')).toBeVisible();
        }).toPass({ timeout: 60_000 });

        // b) Both platform connections, on the shared canvasA fixture.
        await gotoSeededWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');

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
        const srcDialog = page.getByRole('dialog', { name: 'Add Local database (via agent) connection' });
        await expect(srcDialog).toBeVisible();
        await srcDialog.locator('#connection-display-name').fill(SOURCE_CONNECTION_NAME);
        await srcDialog.locator('#connection-field-agentId').selectOption({ label: AGENT_NAME });
        await expect(srcDialog.locator(`#connection-field-agentConnectionId option:has-text("${LOCAL_CONNECTION_LABEL}")`)).toHaveCount(1, {
          timeout: 15_000,
        });
        await srcDialog.locator('#connection-field-agentConnectionId').selectOption({ label: `${LOCAL_CONNECTION_LABEL} (${MSSQL_DATABASE})` });
        await srcDialog.getByRole('button', { name: 'Add connection' }).click();
        await expect(srcDialog).not.toBeVisible({ timeout: 10_000 });

        await rail.getByText('Planometry table', { exact: true }).click();
        const destDialog = page.getByRole('dialog', { name: 'Add Planometry table connection' });
        await expect(destDialog).toBeVisible();
        await destDialog.locator('#connection-display-name').fill(DEST_CONNECTION_NAME);
        await destDialog.locator('#connection-field-address').fill(fakeTable.tableUrl);
        await destDialog.locator('#connection-field-pushKey').fill(fakeTable.pushKey);
        await destDialog.getByRole('button', { name: 'Add connection' }).click();
        await expect(destDialog).not.toBeVisible({ timeout: 10_000 });
      });

      await test.step('b) wire up the Canvas graph, map fields, publish — state becomes applied', async () => {
        const rail = page.getByTestId('nodes-rail');
        const dataTransfer1 = await page.evaluateHandle(() => new DataTransfer());
        await rail.getByText(SOURCE_CONNECTION_NAME, { exact: true }).dispatchEvent('dragstart', { dataTransfer: dataTransfer1 });
        const surface = page.getByTestId('canvas-surface');
        await surface.dispatchEvent('dragover', { dataTransfer: dataTransfer1, clientX: 300, clientY: 200 });
        await surface.dispatchEvent('drop', { dataTransfer: dataTransfer1, clientX: 300, clientY: 200 });
        let picker = page.getByTestId('drop-role-picker');
        if (await picker.isVisible().catch(() => false)) {
          await picker.getByRole('menuitem', { name: 'Use as Source' }).click();
        }

        const dataTransfer2 = await page.evaluateHandle(() => new DataTransfer());
        const transformItem = rail.getByText('Transform', { exact: true });
        await transformItem.dispatchEvent('dragstart', { dataTransfer: dataTransfer2 });
        await surface.dispatchEvent('dragover', { dataTransfer: dataTransfer2, clientX: 600, clientY: 200 });
        await surface.dispatchEvent('drop', { dataTransfer: dataTransfer2, clientX: 600, clientY: 200 });

        const dataTransfer3 = await page.evaluateHandle(() => new DataTransfer());
        await rail.getByText(DEST_CONNECTION_NAME, { exact: true }).dispatchEvent('dragstart', { dataTransfer: dataTransfer3 });
        await surface.dispatchEvent('dragover', { dataTransfer: dataTransfer3, clientX: 900, clientY: 200 });
        await surface.dispatchEvent('drop', { dataTransfer: dataTransfer3, clientX: 900, clientY: 200 });
        picker = page.getByTestId('drop-role-picker');
        if (await picker.isVisible().catch(() => false)) {
          await picker.getByRole('menuitem', { name: 'Use as Destination' }).click();
        }

        await expect(page.locator('.react-flow__node')).toHaveCount(3);

        const nodes = page.locator('.react-flow__node');
        async function connect(fromIdx: number, toIdx: number) {
          const sourceHandle = nodes.nth(fromIdx).locator('.react-flow__handle.source');
          const targetHandle = nodes.nth(toIdx).locator('.react-flow__handle.target');
          const sourceBox = (await sourceHandle.boundingBox())!;
          const targetBox = (await targetHandle.boundingBox())!;
          await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
          await page.mouse.up();
        }
        await connect(0, 1);
        await connect(1, 2);

        // Source node: pick the table, select+key its columns.
        await nodes.nth(0).click();
        let drawer = page.getByTestId('node-drawer');
        await page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema'));
        const sourceTableSelect = drawer.locator('#node-drawer-table-select');
        await expect(sourceTableSelect.locator('option', { hasText: 'widgets' })).toHaveCount(1, { timeout: 10_000 });
        const savedSrcTable = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await sourceTableSelect.selectOption({ label: 'dbo.widgets' });
        await savedSrcTable;

        // AgentSourceColumnsPanel's row is `<div><label><input/><span>{name}</span>...</label>...</div>`
        // — going up two parents from the name span (span -> label -> row
        // div) reaches the row unambiguously, since `drawer.locator('div',
        // {has: ...})` would otherwise also match every ancestor div (DOM
        // order puts those BEFORE the row div, so `.first()` picks the
        // wrong, too-broad one).
        for (const col of ['id', 'name', 'price']) {
          const nameSpan = drawer.locator(`span:text-is("${col}")`);
          const row = nameSpan.locator('xpath=../..');
          const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
          await row.locator('input[type="checkbox"]').first().check();
          await saved;
        }
        const idRow = drawer.locator('span:text-is("id")').locator('xpath=../..');
        const savedKey = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        // The "Key" checkbox only renders once the column above is
        // selected — row.getByText('Key') resolves to its own <label>
        // (plain text child, not wrapped in a span), which directly
        // contains that checkbox.
        await idRow.getByText('Key').locator('input[type="checkbox"]').check();
        await savedKey;

        // Transform node: a filter that passes every seeded row (price >= 0).
        await nodes.nth(1).click();
        drawer = page.getByTestId('node-drawer');
        await drawer.getByRole('button', { name: '+ Filter' }).click();
        await drawer.getByRole('button', { name: '+ Condition' }).click();
        await expect(drawer.getByPlaceholder('field name')).toHaveCount(0, { timeout: 15_000 });
        await drawer.locator('select').nth(0).selectOption('price');
        await drawer.locator('select').nth(1).selectOption('gte');
        const savedFilter1 = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await drawer.getByPlaceholder('value').fill('0');
        await savedFilter1;
        await expect(page.getByText('Saved')).toBeVisible({ timeout: 2_000 });

        // Destination node: pick the fake table, set mode Replace, map fields.
        await nodes.nth(2).click();
        drawer = page.getByTestId('node-drawer');
        await page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema'));
        const destTableSelect = drawer.locator('#node-drawer-table-select');
        await expect(destTableSelect.locator('option', { hasText: FAKE_TABLE_NAME })).toHaveCount(1, { timeout: 10_000 });
        const savedDestTable = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await destTableSelect.selectOption({ label: `planometry.${FAKE_TABLE_NAME}` });
        await savedDestTable;

        const modeSelect = drawer.locator('select').filter({ has: page.locator('option', { hasText: 'Replace' }) });
        const savedMode = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await modeSelect.selectOption({ label: 'Replace' });
        await savedMode;

        await drawer.getByRole('button', { name: 'Field mapping' }).click();
        await drawer.getByRole('button', { name: 'Propose mapping' }).click();
        await expect(drawer.getByRole('button', { name: 'Remove entry' }).first()).toBeVisible({ timeout: 10_000 });
        await drawer.getByRole('button', { name: 'Approve' }).click();
        await expect(drawer.getByRole('button', { name: 'Approve' })).toBeDisabled();

        // Publish — unambiguous here (dialog not yet open).
        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        const publishDialog = page.getByText('Publish to agent?').locator('../..');
        await expect(publishDialog.getByText('This is a new job for the agent.')).toBeVisible({ timeout: 10_000 });
        // Both the header's trigger and the dialog's own confirm button read
        // "Publish" once the dialog is open — .last() targets the dialog's,
        // which FlowCanvas.tsx renders after CanvasHeader with no portal.
        await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

        await expect(page.getByText('Applied · v1')).toBeVisible({ timeout: 30_000 });
      });

      // c) Run now — the fake table ends up holding the source's rows, and
      // run history shows one run with that row count.
      await test.step('c) run now: the fake Planometry table holds the source rows, run history shows one run', async () => {
        await page.getByRole('button', { name: 'Run now', exact: true }).click();
        const runNowDialog = page.getByText('Run now?').locator('../..');
        await expect(runNowDialog).toBeVisible();
        await page.getByRole('button', { name: 'Run now', exact: true }).last().click();
        await expect(runNowDialog).not.toBeVisible({ timeout: 15_000 });

        await expect(async () => {
          const rows = await getFakeTableRows(fakeTableId!);
          expect(rows).toHaveLength(3);
        }).toPass({ timeout: 60_000 });

        await page.getByRole('button', { name: 'Run history', exact: true }).click();
        await expect(page.getByText('3 sent')).toBeVisible({ timeout: 15_000 });
      });

      // d) Change the filter — forces a full reload; publish again at v2.
      await test.step('d) change the filter: publish preview warns of a full reload, applies at v2', async () => {
        await page.locator('.react-flow__node').nth(1).click();
        const drawer = page.getByTestId('node-drawer');
        const savedFilter2 = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await drawer.getByPlaceholder('value').fill('10');
        await savedFilter2;
        await expect(page.getByText('Saved')).toBeVisible({ timeout: 2_000 });

        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        const publishDialog = page.getByText('Publish to agent?').locator('../..');
        await expect(
          publishDialog.getByText('This forces a full reload of the destination the next time the agent runs it.'),
        ).toBeVisible({ timeout: 10_000 });
        await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

        await expect(page.getByText('Applied · v2')).toBeVisible({ timeout: 30_000 });
      });

      // e) Pause, then resume — the job state follows each. No auto-poll for
      // job state (only the publish state auto-refetches while "waiting"),
      // so these need a manual reload + toPass, same convention as
      // agentConnection.spec.ts's "Online" detection.
      await test.step('e) pause, then resume: job state follows each', async () => {
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(async () => {
          await page.reload();
          await expect(page.getByText('paused', { exact: true })).toBeVisible();
        }).toPass({ timeout: 90_000 });

        await page.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(async () => {
          await page.reload();
          await expect(page.getByText('ok', { exact: true })).toBeVisible();
        }).toPass({ timeout: 90_000 });
      });

      // f) Remove the host from the allow-list, publish a change — rejected,
      // with the allow-list reason in the badge's title.
      await test.step('f) remove the host from the allow-list: a new publish is rejected with the allow-list reason', async () => {
        const removeResult = await runCli(['destinations', 'remove', fakeHost!], home);
        expect(removeResult.code, `destinations remove stdout=${removeResult.stdout} stderr=${removeResult.stderr}`).toBe(0);

        await page.locator('.react-flow__node').nth(1).click();
        const drawer = page.getByTestId('node-drawer');
        const savedFilter3 = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
        await drawer.getByPlaceholder('value').fill('1');
        await savedFilter3;
        await expect(page.getByText('Saved')).toBeVisible({ timeout: 2_000 });

        await page.getByRole('button', { name: 'Publish', exact: true }).click();
        const publishDialog = page.getByText('Publish to agent?').locator('../..');
        await expect(publishDialog).toBeVisible();
        await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

        const rejectedBadge = page.getByText('Rejected', { exact: true });
        await expect(rejectedBadge).toBeVisible({ timeout: 30_000 });
        await expect(rejectedBadge).toHaveAttribute('title', /allow-list/, { timeout: 15_000 });
      });
    } finally {
      if (agentChild && (agentChild as ChildProcess).exitCode === null) {
        (agentChild as ChildProcess).kill('SIGKILL');
      }
      if (fakeServerChild && (fakeServerChild as ChildProcess).exitCode === null) {
        await stopFakePlanometryServer(fakeServerChild as ChildProcess);
      }
      try {
        if ((await page.locator('.react-flow__node').count()) > 0) {
          while ((await page.locator('.react-flow__node').count()) > 0) {
            await page.locator('.react-flow__node').first().click();
            await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
          }
          await expect(page.locator('.react-flow__node')).toHaveCount(0);
        }
      } catch {
        // best-effort — don't mask the real test failure/result with a cleanup error
      }
      rmSync(home, { recursive: true, force: true });
      await pool.query('delete from public.connections where display_name = any($1)', [[SOURCE_CONNECTION_NAME, DEST_CONNECTION_NAME]]);
      // agent_setups.workflow_id FK is ON DELETE CASCADE from workflows, but
      // this spec reuses the shared, persistent "Canvas E2E Workflow"
      // fixture rather than deleting it — delete the setup rows (and, via
      // their own ON DELETE CASCADE, the agent_setup_runs rows) directly.
      await pool.query(
        `delete from public.agent_setups where workflow_id = (
           select w.id from public.workflows w
           join public.projects p on p.id = w.project_id
           where p.name = 'Canvas E2E Project' and w.name = 'Canvas E2E Workflow'
         )`,
      );
      if (agentId) {
        await pool.query('delete from public.platform_agents where id = $1', [agentId]);
      }
      await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
      await pool.end();
    }
  });
});
