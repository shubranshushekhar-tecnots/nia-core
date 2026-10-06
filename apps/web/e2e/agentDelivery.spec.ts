import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
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

/**
 * Same compound-cookie-as-bearer-token convention as copilot.spec.ts's own
 * getAccessToken — see that file's header comment for why the whole
 * `better-auth.session_token` cookie value is a valid `Authorization:
 * Bearer` value for apps/api's requireAuth routes, no splitting needed.
 */
async function getAccessToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => /(^|\.)session_token$/.test(c.name));
  if (!authCookie) throw new Error('No better-auth session cookie on this context — is the persona logged in?');
  return decodeURIComponent(authCookie.value);
}

/**
 * Saves a full GraphDoc through the exact same PUT .../graph call the
 * Canvas's own autosave uses (graphClient.ts's putWorkflowGraph) — fetches
 * the current version first so this always satisfies the optimistic-
 * concurrency check, same pattern as copilot.spec.ts's seedRes/afterEditRes.
 */
async function saveGraphViaApi(
  page: Page,
  workflowId: string,
  apiUrl: string,
  authHeaders: Record<string, string>,
  graph: unknown,
): Promise<void> {
  const currentRes = await page.request.get(`${apiUrl}/workflows/${workflowId}/graph`, { headers: authHeaders });
  expect(currentRes.ok(), `GET graph should succeed: ${currentRes.status()} ${await currentRes.text()}`).toBeTruthy();
  const current = await currentRes.json();
  const saveRes = await page.request.put(`${apiUrl}/workflows/${workflowId}/graph`, {
    headers: authHeaders,
    data: { graph, expectedVersion: current.version },
  });
  expect(saveRes.ok(), `graph PUT should succeed: ${saveRes.status()} ${await saveRes.text()}`).toBeTruthy();
}

function currentWorkflowId(page: Page): string {
  const id = page.url().match(/\/app\/workflows\/([0-9a-f-]{36})/)?.[1];
  if (!id) throw new Error(`could not parse workflow id from ${page.url()}`);
  return id;
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
    test.setTimeout(15 * 60 * 1000);

    const home = mkdtempSync(path.join(tmpdir(), 'nia-agent-e2e-ad-'));
    let agentChild: ChildProcess | null = null;
    let fakeServerChild: ChildProcess | null = null;
    let agentId: string | null = null;
    let fakeTableId: string | null = null;
    let fakeHost: string | null = null;
    // Built by step b), mutated in place by steps d)/f) — each save PUTs
    // the whole, current GraphDoc through saveGraphViaApi.
    let agentGraph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } | null = null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4001';

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
      }, { timeout: 3 * 60 * 1000 });

      await test.step(
        'b) wire up the Canvas graph through the same API call Canvas autosave uses, publish in the UI — state becomes applied',
        async () => {
          const workflowId = currentWorkflowId(page);
          const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };

          const connsRes = await page.request.get(`${apiUrl}/connections`, { headers: authHeaders });
          expect(connsRes.ok(), `GET connections should succeed: ${connsRes.status()} ${await connsRes.text()}`).toBeTruthy();
          const conns = (await connsRes.json()) as { id: string; displayName: string }[];
          const sourceConn = conns.find((c) => c.displayName === SOURCE_CONNECTION_NAME);
          const destConn = conns.find((c) => c.displayName === DEST_CONNECTION_NAME);
          expect(sourceConn, 'source connection should exist').toBeTruthy();
          expect(destConn, 'destination connection should exist').toBeTruthy();

          // Source block on dbo.widgets with all three columns selected and
          // `id` keyed; a filter that passes every seeded row (price >= 0);
          // a Planometry destination in Replace mode with every key column
          // mapped — same end state the UI drag/drop + drawer edits used to
          // produce, reached here through the one API call Canvas autosave
          // itself calls (graphClient.ts's PUT .../graph).
          agentGraph = {
            nodes: [
              {
                id: 'src',
                type: 'source',
                manifestId: 'sqlserver-agent',
                connectionId: sourceConn!.id,
                position: { x: 100, y: 100 },
                config: {
                  operation: 'read',
                  entity: { namespace: 'dbo', name: 'widgets' },
                  columns: [
                    { name: 'id', type: 'int', isKey: true },
                    { name: 'name', type: 'nvarchar', isKey: false },
                    { name: 'price', type: 'decimal', isKey: false },
                  ],
                  params: {},
                },
              },
              {
                id: 't1',
                type: 'transform',
                position: { x: 400, y: 100 },
                config: {
                  steps: [
                    {
                      kind: 'filter',
                      expr: {
                        kind: 'comparison',
                        op: 'gte',
                        left: { kind: 'field', name: 'price' },
                        right: { kind: 'literal', value: 0 },
                      },
                    },
                  ],
                },
              },
              {
                id: 'dest',
                type: 'destination',
                manifestId: 'planometry-table',
                connectionId: destConn!.id,
                position: { x: 700, y: 100 },
                config: {
                  operation: 'insert',
                  entity: { namespace: 'planometry', name: FAKE_TABLE_NAME },
                  mapping: {
                    version: 1,
                    entries: [
                      { from: 'id', to: 'id' },
                      { from: 'name', to: 'name' },
                      { from: 'price', to: 'price' },
                    ],
                    approvedAt: new Date().toISOString(),
                    sourceColumnsAtApproval: ['id', 'name', 'price'],
                  },
                  delivery: { mode: 'replace' },
                },
              },
            ],
            edges: [
              { id: 'e0', source: 'src', target: 't1' },
              { id: 'e1', source: 't1', target: 'dest' },
            ],
          };

          await saveGraphViaApi(page, workflowId, apiUrl, authHeaders, agentGraph);

          await page.reload();
          await expect(page.locator('.react-flow__node')).toHaveCount(3);

          // Publish — unambiguous here (dialog not yet open).
          await page.getByRole('button', { name: 'Publish', exact: true }).click();
          const publishDialog = page.getByText('Publish to agent?').locator('../..');
          await expect(publishDialog.getByText('This is a new job for the agent.')).toBeVisible({ timeout: 10_000 });
          // Both the header's trigger and the dialog's own confirm button read
          // "Publish" once the dialog is open — .last() targets the dialog's,
          // which FlowCanvas.tsx renders after CanvasHeader with no portal.
          await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

          await expect(page.getByText('Applied · v1')).toBeVisible({ timeout: 30_000 });
        },
        { timeout: 3 * 60 * 1000 },
      );

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

        // The run's report only reaches the platform on the agent's *next*
        // check-in (it was already running/held when the run finished) —
        // up to ~CHECK_IN_HOLD_MS (25s) plus a round trip, same as the
        // revoke-visibility wait in agents.spec.ts. 45s margin, same reason.
        await page.getByRole('button', { name: 'Run history', exact: true }).click();
        await expect(page.getByText('3 sent')).toBeVisible({ timeout: 45_000 });
      }, { timeout: 3 * 60 * 1000 });

      // d) Change the filter — forces a full reload; publish again at v2.
      await test.step(
        'd) change the filter via the same API save call: publish preview warns of a full reload, applies at v2',
        async () => {
          const workflowId = currentWorkflowId(page);
          const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };

          const transformNode = agentGraph!.nodes.find((n) => n.id === 't1') as {
            config: { steps: { expr: { right: { value: number } } }[] };
          };
          transformNode.config.steps[0]!.expr.right.value = 10;
          await saveGraphViaApi(page, workflowId, apiUrl, authHeaders, agentGraph);

          await page.reload();

          await page.getByRole('button', { name: 'Publish', exact: true }).click();
          const publishDialog = page.getByText('Publish to agent?').locator('../..');
          await expect(
            publishDialog.getByText('This forces a full reload of the destination the next time the agent runs it.'),
          ).toBeVisible({ timeout: 10_000 });
          await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

          await expect(page.getByText('Applied · v2')).toBeVisible({ timeout: 30_000 });
        },
        { timeout: 3 * 60 * 1000 },
      );

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
      }, { timeout: 3 * 60 * 1000 });

      // f) Remove the host from the allow-list, publish a change — rejected,
      // with the allow-list reason in the badge's title.
      await test.step(
        'f) remove the host from the allow-list: a new publish (via the same API save call) is rejected with the allow-list reason',
        async () => {
          const removeResult = await runCli(['destinations', 'remove', fakeHost!], home);
          expect(removeResult.code, `destinations remove stdout=${removeResult.stdout} stderr=${removeResult.stderr}`).toBe(0);

          const workflowId = currentWorkflowId(page);
          const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };

          const transformNode = agentGraph!.nodes.find((n) => n.id === 't1') as {
            config: { steps: { expr: { right: { value: number } } }[] };
          };
          transformNode.config.steps[0]!.expr.right.value = 1;
          await saveGraphViaApi(page, workflowId, apiUrl, authHeaders, agentGraph);

          await page.reload();

          await page.getByRole('button', { name: 'Publish', exact: true }).click();
          const publishDialog = page.getByText('Publish to agent?').locator('../..');
          await expect(publishDialog).toBeVisible();
          await page.getByRole('button', { name: 'Publish', exact: true }).last().click();

          const rejectedBadge = page.getByText('Rejected', { exact: true });
          await expect(rejectedBadge).toBeVisible({ timeout: 30_000 });
          await expect(rejectedBadge).toHaveAttribute('title', /allow-list/, { timeout: 15_000 });
        },
        { timeout: 3 * 60 * 1000 },
      );
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
      // agent_setups.workflow_id FK is ON DELETE CASCADE from workflows, but
      // this spec reuses the shared, persistent "Canvas E2E Workflow"
      // fixture rather than deleting it — delete the setup rows (and, via
      // their own ON DELETE CASCADE, the agent_setup_runs rows) directly.
      // Must run before the connections delete below: agent_setups has its
      // own FK on connection_id, so deleting connections first violates
      // agent_setups_connection_id_fkey.
      await pool.query(
        `delete from public.agent_setups where workflow_id = (
           select w.id from public.workflows w
           join public.projects p on p.id = w.project_id
           where p.name = 'Canvas E2E Project' and w.name = 'Canvas E2E Workflow'
         )`,
      );
      await pool.query('delete from public.connections where display_name = any($1)', [[SOURCE_CONNECTION_NAME, DEST_CONNECTION_NAME]]);
      if (agentId) {
        await pool.query('delete from public.platform_agents where id = $1', [agentId]);
      }
      await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
      await pool.end();
    }
  });
});
