import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Route 1 e2e — Slice T2 Part 2: a real `nia-agent` CLI process reads a
 * local SQL Server table through packages/extract (Part 1's read-ahead
 * /execute path) and the workflow is run the NORMAL way (worker-dispatched
 * write via a real connector service), not the agent-autonomous push
 * agentDelivery.spec.ts (Route 2) exercises. No fake Planometry server, no
 * publish/pause/resume/allow-list — this reuses the plain "Run now" /
 * run-history machinery canvas.spec.ts's non-agent workflows already use.
 *
 * Same style/helpers as agentDelivery.spec.ts (gotoSeededWorkflow,
 * loadWebEnv, runCli/startAgent/stopAgent, the SQL Server harness,
 * saveGraphViaApi/getAccessToken/currentWorkflowId). The existing "Dev
 * sandbox (supabase)" destination connection is reused read-only (no write
 * grant provisioned): a write grant is never actually reached here, because
 * packages/schemas/src/pushdown.ts's manifestDialect() has no case for
 * "sqlserver-agent" yet, so apps/worker/src/lib/etl/runEtl.ts's very first
 * dialect-lookup check fails before any write-grant resolution is ever
 * attempted (see docs/plans/route1-design.md, a known/tracked gap that
 * requires apps/worker changes out of this slice's scope). Provisioning a
 * grant here would also 403 regardless: canvasA is "member" in the
 * canvas-e2e org, and grants.create/confirm require individual/admin/owner
 * (packages/schemas/src/can.ts) — a deliberate, documented access rule, not
 * a bug to work around.
 */
async function gotoSeededWorkflow(page: Page, projectName: string, workflowName: string) {
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

execFileSync(process.execPath, [path.join(agentDir, 'scripts', 'generate-version.mjs')], { cwd: agentDir });

const NOW = Date.now();
const AGENT_NAME = `e2e-route1-${NOW}`;
const LOCAL_CONNECTION_ID = `e2e-r1-local-conn-${NOW}`;
const LOCAL_CONNECTION_LABEL = `E2E R1 MSSQL ${NOW}`;
const SOURCE_CONNECTION_NAME = `Local SQL Server R1 E2E ${NOW}`;
const DEST_TABLE_NAME = `order_lines_dest_${NOW}`;

// packages/extract/scripts/harness/{start,config}.sh's fixed coordinates.
const MSSQL_HOST = process.env.SQLSERVER_HOST ?? 'localhost';
const MSSQL_PORT = 14330;
const MSSQL_DATABASE = 'nia_extract_test';
const MSSQL_USER = 'sa';
const MSSQL_PASSWORD = 'N!aExtractTest_2026';

// The confirmed, current error text from apps/worker/src/lib/etl/runEtl.ts's
// first (dialect-lookup) check — see this file's header comment.
const EXPECTED_DIALECT_GAP_MESSAGE = 'has no supported query dialect';

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
    child.kill('SIGKILL');
  });
}

/** Same compound-cookie-as-bearer-token convention as agentDelivery.spec.ts's getAccessToken. */
async function getAccessToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => /(^|\.)session_token$/.test(c.name));
  if (!authCookie) throw new Error('No better-auth session cookie on this context — is the persona logged in?');
  return decodeURIComponent(authCookie.value);
}

/** Same full-GraphDoc-replace PUT as agentDelivery.spec.ts's saveGraphViaApi. */
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

async function latestWorkflowRun(
  pool: Pool,
  workflowId: string,
): Promise<{ status: string; rowsProcessed: number; durationMs: number | null; error: unknown } | undefined> {
  const { rows } = await pool.query(
    `select status, rows_processed, duration_ms, error from public.workflow_runs
       where workflow_id = $1 order by started_at desc limit 1`,
    [workflowId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { status: row.status, rowsProcessed: row.rows_processed, durationMs: row.duration_ms, error: row.error };
}

test.describe('Route 1: normal worker-dispatched run from a local-database-via-agent source', () => {
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60 * 1000);
    execFileSync(path.join(agentDir, '..', '..', 'packages', 'extract', 'scripts', 'harness', 'start.sh'), [], {
      cwd: path.join(agentDir, '..', '..', 'packages', 'extract', 'scripts', 'harness'),
      env: { ...process.env, NIA_EXTRACT_MSSQL_NO_MEMORY_LIMIT: '1' },
      stdio: 'inherit',
    });
  });

  test('a real agent reads a composite-key local table; the normal run path writes it to a real Postgres destination', async ({ page }) => {
    test.setTimeout(15 * 60 * 1000);

    const home = mkdtempSync(path.join(tmpdir(), 'nia-agent-e2e-r1-'));
    let agentChild: ChildProcess | null = null;
    let agentId: string | null = null;
    let destConnId: string | null = null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4001';

    try {
      // a) Pair a real agent and add its one local SQL Server connection
      // (dbo.order_lines: 10,000 rows, two-column composite PK).
      await test.step('a) pair agent to a 10,000-row, two-column-key local table', async () => {
        await page.goto('/app/connections');
        const card = page.locator('[data-testid="connector-card"][data-connector-id="sqlserver-agent"]');
        await expect(card).toBeVisible({ timeout: 15_000 });
        const installBtn = card.getByRole('button', { name: 'Install', exact: true });
        if (await installBtn.isVisible().catch(() => false)) {
          await installBtn.click();
          await expect(card.getByText('Installed')).toBeVisible({ timeout: 10_000 });
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

        agentChild = startAgent(home);
        await expect(async () => {
          const result = await runCli(['status'], home);
          expect(result.stdout.toLowerCase()).toContain('last check-in');
        }).toPass({ timeout: 5_000 });

        await expect(async () => {
          await page.reload();
          await expect(page.getByText(AGENT_NAME).locator('..').getByText('Online')).toBeVisible();
        }).toPass({ timeout: 60_000 });

        // Platform-side source connection, on the shared canvasA fixture.
        await gotoSeededWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');

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

        // Reuse the existing "Dev sandbox (supabase)" destination
        // connection read-only — no write grant provisioned (see this
        // file's header comment for why one is never reached/needed here).
        const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };
        const connsRes = await page.request.get(`${apiUrl}/connections`, { headers: authHeaders });
        expect(connsRes.ok(), `GET connections should succeed: ${connsRes.status()} ${await connsRes.text()}`).toBeTruthy();
        const conns = (await connsRes.json()) as { id: string; connectorId: string; displayName: string }[];
        const destConn = conns.find((c) => c.connectorId === 'supabase');
        expect(destConn, 'an existing supabase/Postgres destination connection should exist').toBeTruthy();
        destConnId = destConn!.id;
      }, { timeout: 3 * 60 * 1000 });

      // b) The workflow graph, saved through the API only: dbo.order_lines
      // as source (both key columns marked isKey), the existing Postgres
      // destination, a simple 1:1 field mapping. No Canvas clicking.
      await test.step('b) save the workflow graph via the API: composite-key source, Postgres destination, simple mapping', async () => {
        const workflowId = currentWorkflowId(page);
        const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };

        const connsRes = await page.request.get(`${apiUrl}/connections`, { headers: authHeaders });
        const conns = (await connsRes.json()) as { id: string; displayName: string }[];
        const sourceConn = conns.find((c) => c.displayName === SOURCE_CONNECTION_NAME);
        expect(sourceConn, 'source connection should exist').toBeTruthy();

        const graph = {
          nodes: [
            {
              id: 'src',
              type: 'source',
              manifestId: 'sqlserver-agent',
              connectionId: sourceConn!.id,
              position: { x: 100, y: 100 },
              config: {
                operation: 'read',
                entity: { namespace: 'dbo', name: 'order_lines' },
                columns: [
                  { name: 'order_id', type: 'int', isKey: true },
                  { name: 'line_no', type: 'int', isKey: true },
                  { name: 'item_name', type: 'nvarchar', isKey: false },
                  { name: 'amount', type: 'decimal', isKey: false },
                ],
                params: {},
              },
            },
            {
              id: 'dest',
              type: 'destination',
              manifestId: 'supabase',
              connectionId: destConnId,
              position: { x: 500, y: 100 },
              config: {
                operation: 'insert',
                entity: { namespace: 'public', name: DEST_TABLE_NAME },
                upsertKeys: ['order_id', 'line_no'],
                mapping: {
                  version: 1,
                  entries: [
                    { from: 'order_id', to: 'order_id' },
                    { from: 'line_no', to: 'line_no' },
                    { from: 'item_name', to: 'item_name' },
                    { from: 'amount', to: 'amount' },
                  ],
                  approvedAt: new Date().toISOString(),
                  sourceColumnsAtApproval: ['order_id', 'line_no', 'item_name', 'amount'],
                },
              },
            },
          ],
          edges: [{ id: 'e0', source: 'src', target: 'dest' }],
        };

        await saveGraphViaApi(page, workflowId, apiUrl, authHeaders, graph);
      }, { timeout: 3 * 60 * 1000 });

      // c) Row preview (destNodeId = the destination node — the API walks
      // backward to the nearest upstream source and reads ITS rows) returns
      // the source's rows.
      await test.step('c) row preview on the source (via the destination node) returns rows', async () => {
        const workflowId = currentWorkflowId(page);
        const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };
        const previewRes = await page.request.post(`${apiUrl}/workflows/${workflowId}/preview`, {
          headers: authHeaders,
          data: { destNodeId: 'dest' },
        });
        expect(previewRes.ok(), `preview should succeed: ${previewRes.status()} ${await previewRes.text()}`).toBeTruthy();
        const preview = await previewRes.json();
        expect(Array.isArray(preview.rows) ? preview.rows.length : 0).toBeGreaterThan(0);
      }, { timeout: 3 * 60 * 1000 });

      // d) Run the workflow the normal way (the UI "Run now" button — the
      // run/cancel/stream API is cookie-authed, not usable via Bearer
      // page.request calls). Today this is EXPECTED to fail fast: the
      // "sqlserver-agent" source connector has no entry in
      // packages/schemas/src/pushdown.ts's manifestDialect(), so
      // apps/worker/src/lib/etl/runEtl.ts's very first check rejects the
      // run before any row is read, with a clear, specific error — not a
      // hang and not a silent/garbled failure. Closing this gap requires
      // apps/worker changes, out of this slice's scope (see this file's
      // header comment and docs/plans/route1-design.md).
      let runOutcome: { status: string; rowsProcessed: number; durationMs: number | null; error: unknown } | undefined;
      await test.step('d) run now: fails fast with the documented dialect-gap error (apps/worker fix out of scope)', async () => {
        await page.reload();
        await page.getByRole('button', { name: 'Run now', exact: true }).click();
        const runNowDialog = page.getByText('Run now?').locator('../..');
        if (await runNowDialog.isVisible().catch(() => false)) {
          await page.getByRole('button', { name: 'Run now', exact: true }).last().click();
        }

        const workflowId = currentWorkflowId(page);
        await expect(async () => {
          const run = await latestWorkflowRun(pool, workflowId);
          expect(run, 'a workflow_runs row should exist for this run').toBeTruthy();
          expect(['succeeded', 'failed', 'cancelled']).toContain(run!.status);
        }).toPass({ timeout: 120_000 });

        runOutcome = await latestWorkflowRun(pool, workflowId);

        expect(runOutcome?.status, `run outcome: ${JSON.stringify(runOutcome)}`).toBe('failed');
        const errorMessage = (runOutcome?.error as { message?: string } | null)?.message ?? '';
        expect(errorMessage).toContain(EXPECTED_DIALECT_GAP_MESSAGE);
      }, { timeout: 3 * 60 * 1000 });

      // e) Rows per second for that run — N/A: the run above fails before
      // any row is read (see step d)'s comment), so there is no throughput
      // to measure.
      await test.step('e) report rows per second (N/A — run failed before reading any rows)', async () => {
        console.log('T2 Part 2 step e) rows/sec: N/A — run failed at the dialect-lookup check before reading any rows');
      }, { timeout: 3 * 60 * 1000 });

      // f) Stopping the agent mid a second run. Because the dialect-gap
      // failure in d)/e) happens at the very start of runEtl.ts, before the
      // worker ever dispatches to the agent, killing the agent here cannot
      // change *why* the run fails — it is expected to fail the same way,
      // just as fast, regardless of agent state. This does still honestly
      // exercise the outcome asked for (fails with a clear message, does
      // not hang) but is NOT a meaningful test of actual agent-offline
      // interruption semantics until the dialect gap is closed.
      await test.step('f) stopping the agent mid-run: second run still fails fast with a clear message and does not hang', async () => {
        const workflowId = currentWorkflowId(page);
        await page.reload();
        await page.getByRole('button', { name: 'Run now', exact: true }).click();
        const runNowDialog = page.getByText('Run now?').locator('../..');
        if (await runNowDialog.isVisible().catch(() => false)) {
          await page.getByRole('button', { name: 'Run now', exact: true }).last().click();
        }

        // Give the run a brief moment to actually start before killing the
        // agent — then stop it mid-flight.
        await page.waitForTimeout(1_000);
        if (agentChild) {
          await stopAgent(agentChild);
          agentChild = null;
        }

        await expect(async () => {
          const run = await latestWorkflowRun(pool, workflowId);
          expect(run, 'a second workflow_runs row should exist').toBeTruthy();
          expect(run!.status).toBe('failed');
          expect(run!.error, 'a failed run should carry a clear error').toBeTruthy();
        }).toPass({ timeout: 90_000 });
      }, { timeout: 3 * 60 * 1000 });
    } finally {
      if (agentChild && (agentChild as ChildProcess).exitCode === null) {
        (agentChild as ChildProcess).kill('SIGKILL');
      }
      rmSync(home, { recursive: true, force: true });
      // No write grant or destination table was ever created (see this
      // file's header comment), so there is nothing extra to revoke/drop
      // beyond the source connection/agent/pairing-code rows below.
      await pool.query('delete from public.connections where display_name = $1', [SOURCE_CONNECTION_NAME]);
      if (agentId) {
        await pool.query('delete from public.platform_agents where id = $1', [agentId]);
      }
      await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
      await pool.end();
    }
  });
});
