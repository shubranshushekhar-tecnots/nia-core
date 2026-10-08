import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { Pool, Client } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Route 1 e2e — Slice T2 Part 2: a real `nia-agent` CLI process reads a
 * local SQL Server table through packages/extract (Part 1's read-ahead
 * /execute path) and the workflow is run the NORMAL way (worker-dispatched
 * write via a real connector service), not the agent-autonomous push
 * agentDelivery.spec.ts (Route 2) exercises. No fake Planometry server, no
 * publish/pause/resume/allow-list — this reuses the plain "Run checks" /
 * "Run" / run-history machinery canvas.spec.ts's non-agent workflows already use.
 *
 * Same style/helpers as agentDelivery.spec.ts (gotoSeededWorkflow,
 * loadWebEnv, runCli/startAgent/stopAgent, the SQL Server harness,
 * saveGraphViaApi/getAccessToken/currentWorkflowId). The existing "Dev
 * sandbox (supabase)" destination connection is reused for its read-side
 * config (host/port/database), but a real write grant must now be in
 * place: packages/schemas/src/pushdown.ts's manifestDialect() has no case
 * for "sqlserver-agent", but apps/worker/src/lib/etl/runEtl.ts resolves
 * that to the "structured" pseudo-dialect instead (see
 * docs/plans/route1-complete.md) — so the run proceeds all the way to
 * write-grant resolution.
 *
 * canvasA ("member" in canvas-e2e) cannot call grants.create/confirm
 * (packages/schemas/src/can.ts requires individual/admin/owner) — a
 * deliberate access rule this test does not touch. Instead, this test's
 * own setup provisions a throwaway write-capable Postgres role on the
 * sandbox destination DB, stores its credential the same way the product
 * does (a real `POST /connections` call, which canvasA's "member" role can
 * make — connections.create is all-role), and inserts a confirmed
 * `write_grants` row directly (service-role-equivalent, same as this
 * file's other direct `pool.query` fixture rows below) pointing at that
 * credential. No RLS policy or RPC is bypassed or changed; this only
 * supplies data a real admin/owner would otherwise have supplied through
 * the (unchanged) grants.create/confirm RPCs.
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

// docker-compose.yml's dev-postgres host-published port (sandbox db) — same
// coordinates apps/worker/scripts/write-smoke.ts uses to provision a
// scratch write role, from the host, for the write-grant fixture below.
const SANDBOX_PG_HOST_PORT = { host: 'localhost', port: 5433, database: 'sandbox', user: 'postgres', password: 'devroot' };
const WRITE_ROLE_USER = `nia_write_e2e_r1_${NOW}`;
const WRITE_ROLE_PASSWORD = `nia_write_e2e_r1_pw_${NOW}`;
const WRITE_CRED_CONNECTION_NAME = `Write cred E2E R1 ${NOW}`;

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

/**
 * Provisions a throwaway write-capable Postgres role on the sandbox
 * destination db, connecting from the host via dev-postgres's published
 * port — same pattern as write-smoke.ts's provisionScratchTableAndRole,
 * but granting CREATE (not just INSERT/UPDATE on one pre-existing table)
 * since apps/worker's ensureDestination.ts issues a real CREATE TABLE for
 * a brand-new destination entity like DEST_TABLE_NAME.
 */
async function provisionWriteRole(): Promise<void> {
  const client = new Client(SANDBOX_PG_HOST_PORT);
  await client.connect();
  try {
    await client.query(`create role ${WRITE_ROLE_USER} with login password '${WRITE_ROLE_PASSWORD}'`);
    await client.query(`grant connect on database sandbox to ${WRITE_ROLE_USER}`);
    await client.query(`grant usage, create on schema public to ${WRITE_ROLE_USER}`);
    // The staging/upsert path provisions its own "nia" schema for staging
    // tables (create-schema-nia preflight check) — the admin-run grant DDL
    // the worker's own error message points at, applied here since this is
    // a scratch role this test owns end-to-end.
    await client.query(`create schema if not exists "nia"`);
    await client.query(`grant usage, create on schema "nia" to ${WRITE_ROLE_USER}`);
  } finally {
    await client.end();
  }
}

/** Drops the destination table the run created, then the scratch write role. */
async function dropWriteRoleAndTable(destTableName: string): Promise<void> {
  const client = new Client(SANDBOX_PG_HOST_PORT);
  await client.connect();
  try {
    await client.query(`drop table if exists public.${destTableName}`);
    const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [WRITE_ROLE_USER]);
    if (rowCount) {
      await client.query(`drop owned by ${WRITE_ROLE_USER}`);
      await client.query(`drop role if exists ${WRITE_ROLE_USER}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Stores the write role's credential the same way the product does — a
 * real `POST /connections` call (canvasA's "member" role can make this;
 * connections.create is all-role, see packages/schemas/src/can.ts) — then
 * reads back the resulting `vault_secret_ref` directly (it is an internal
 * column, never returned by the API) and inserts a confirmed write_grants
 * row for `destConnectionId` pointing at it. Returns both ids for cleanup.
 */
async function provisionWriteGrantFixture(
  page: Page,
  pool: Pool,
  apiUrl: string,
  authHeaders: Record<string, string>,
  destConnectionId: string,
  granterEmail: string,
): Promise<{ writeCredConnId: string; writeGrantId: string }> {
  const createRes = await page.request.post(`${apiUrl}/connections`, {
    headers: authHeaders,
    data: {
      connectorId: 'supabase',
      displayName: WRITE_CRED_CONNECTION_NAME,
      fields: {
        host: 'dev-postgres',
        port: 5432,
        database: 'sandbox',
        ssl: false,
        user: WRITE_ROLE_USER,
        password: WRITE_ROLE_PASSWORD,
      },
    },
  });
  expect(createRes.ok(), `write-cred connection create should succeed: ${createRes.status()} ${await createRes.text()}`).toBeTruthy();
  const writeCredConnId = (await createRes.json()).id as string;

  const { rows: vaultRows } = await pool.query('select vault_secret_ref from public.connections where id = $1', [writeCredConnId]);
  const vaultRef = vaultRows[0]?.vault_secret_ref as string | undefined;
  if (!vaultRef) throw new Error(`write-cred connection ${writeCredConnId} has no vault_secret_ref`);

  const { rows: userRows } = await pool.query('select id from public."user" where email = $1', [granterEmail]);
  const granterId = userRows[0]?.id as string | undefined;
  if (!granterId) throw new Error(`could not find public.user row for ${granterEmail}`);

  // connector-supabase's write pool cache is keyed
  // `connectionId:write:credVersion` (services/connector-supabase/src/
  // pool-manager.ts) and lives for the life of that long-running service
  // process, not just this test run — cred_version's table default (1)
  // would collide with a pool any earlier run (including a failed one)
  // already cached for this same reused destConnectionId, serving this
  // run stale, now-invalid credentials. Forcing a fresh max+1 per
  // destConnectionId guarantees a new cache key every run.
  const { rows: grantRows } = await pool.query(
    `insert into public.write_grants (connection_id, granted_by_user_id, scope, confirmed_at, write_credential_vault_ref, cred_version)
     values ($1, $2, $3, now(), $4, (select coalesce(max(cred_version), 0) + 1 from public.write_grants where connection_id = $1))
     returning id`,
    [destConnectionId, granterId, JSON.stringify({ schemas: ['public'] }), vaultRef],
  );
  const writeGrantId = grantRows[0].id as string;

  return { writeCredConnId, writeGrantId };
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
    let writeCredConnId: string | null = null;
    let writeGrantId: string | null = null;
    let writeRoleProvisioned = false;
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
        // connection's config, but it needs a real, confirmed write grant
        // now that the structured-dialect gap is closed (see this file's
        // header comment) — provision one via this test's own fixture.
        const authHeaders = { Authorization: `Bearer ${await getAccessToken(page)}` };
        const connsRes = await page.request.get(`${apiUrl}/connections`, { headers: authHeaders });
        expect(connsRes.ok(), `GET connections should succeed: ${connsRes.status()} ${await connsRes.text()}`).toBeTruthy();
        const conns = (await connsRes.json()) as { id: string; connectorId: string; displayName: string }[];
        const destConn = conns.find((c) => c.connectorId === 'supabase');
        expect(destConn, 'an existing supabase/Postgres destination connection should exist').toBeTruthy();
        destConnId = destConn!.id;

        await provisionWriteRole();
        writeRoleProvisioned = true;
        const grant = await provisionWriteGrantFixture(page, pool, apiUrl, authHeaders, destConnId, personas.canvasA.email);
        writeCredConnId = grant.writeCredConnId;
        writeGrantId = grant.writeGrantId;
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

      // d) Run the workflow the normal way (the UI "Run checks" + "Run"
      // buttons — the run/cancel/stream API is cookie-authed, not usable
      // via Bearer page.request calls). The structured-dialect gap is now
      // closed (runEtl.ts resolves "sqlserver-agent" to the "structured"
      // pseudo-dialect) and a confirmed write grant was provisioned in
      // step a), so this run is expected to actually read the agent's
      // 10,000-row local table and write it to the real Postgres
      // destination.
      let runOutcome: { status: string; rowsProcessed: number; durationMs: number | null; error: unknown } | undefined;
      await test.step('d) run now: succeeds end-to-end (structured-dialect gap closed, write grant provisioned)', async () => {
        await page.reload();
        // "Run" is gated on a fresh "Run checks" pass (FlowCanvas.tsx's
        // runEnabled: !checksStale && failingChecks === 0) — the graph was
        // just saved via the API in step b), so the client has no check
        // run for this graphVersion yet. Single-destination graphs run
        // immediately on click (Phase 6 Block 3 removed the old "Run now?"
        // confirm modal — see canvas.spec.ts's equivalent Run flow).
        await page.getByRole('button', { name: 'Run checks' }).click();
        const runBtn = page.getByRole('button', { name: 'Run', exact: true });
        await expect(runBtn).toBeEnabled({ timeout: 15_000 });
        await runBtn.click();

        const workflowId = currentWorkflowId(page);
        await expect(async () => {
          const run = await latestWorkflowRun(pool, workflowId);
          expect(run, 'a workflow_runs row should exist for this run').toBeTruthy();
          expect(['succeeded', 'failed', 'cancelled']).toContain(run!.status);
        }).toPass({ timeout: 120_000 });

        runOutcome = await latestWorkflowRun(pool, workflowId);

        expect(runOutcome?.status, `run outcome: ${JSON.stringify(runOutcome)}`).toBe('succeeded');
        expect(runOutcome?.rowsProcessed, `run outcome: ${JSON.stringify(runOutcome)}`).toBeGreaterThan(0);
      }, { timeout: 3 * 60 * 1000 });

      // e) Rows per second for the successful run in d).
      await test.step('e) report rows per second', async () => {
        const rows = runOutcome?.rowsProcessed ?? 0;
        const ms = runOutcome?.durationMs ?? 0;
        const rowsPerSec = ms > 0 ? rows / (ms / 1000) : null;
        console.log(`T2 Part 2 step e) rows/sec: ${rowsPerSec ?? 'N/A'} (rows=${rows}, durationMs=${ms})`);
        expect(rowsPerSec, `durationMs should be a positive number alongside rowsProcessed=${rows}`).not.toBeNull();
        expect(rowsPerSec!).toBeGreaterThan(0);
      }, { timeout: 3 * 60 * 1000 });

      // f) Stopping the agent mid a second run. Now that the run actually
      // reaches the agent-dispatch phase, killing the agent partway
      // through genuinely exercises agent-offline interruption semantics:
      // the run is expected to fail with a clear error, not hang.
      await test.step('f) stopping the agent mid-run: second run fails with a clear message and does not hang', async () => {
        const workflowId = currentWorkflowId(page);
        await page.reload();
        // Checks aren't stale here (nothing changed the graph since step
        // d)'s "Run checks" pass) — "Run" is enabled on reload, no
        // confirm modal for this single-destination graph (see step d)'s
        // comment).
        const runBtn = page.getByRole('button', { name: 'Run', exact: true });
        await expect(runBtn).toBeEnabled({ timeout: 15_000 });
        await runBtn.click();

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
      // Reverse order of provisioning: the write_grants row and its
      // throwaway credential connection/secret first, then the Postgres
      // role + any destination table it created, then the usual source
      // connection/agent/pairing-code rows.
      if (writeGrantId) {
        await pool.query('delete from public.write_grants where id = $1', [writeGrantId]);
      }
      if (writeCredConnId) {
        const { rows } = await pool.query('select vault_secret_ref from public.connections where id = $1', [writeCredConnId]);
        const vaultRef = rows[0]?.vault_secret_ref as string | undefined;
        await pool.query('delete from public.connections where id = $1', [writeCredConnId]);
        if (vaultRef) {
          await pool.query('delete from public.nia_secrets where id = $1', [vaultRef]);
        }
      }
      if (writeRoleProvisioned) {
        await dropWriteRoleAndTable(DEST_TABLE_NAME);
      }
      await pool.query('delete from public.connections where display_name = $1', [SOURCE_CONNECTION_NAME]);
      if (agentId) {
        await pool.query('delete from public.platform_agents where id = $1', [agentId]);
      }
      await pool.query('delete from public.agent_pairing_codes where display_name = $1', [AGENT_NAME]);
      await pool.end();
    }
  });
});
