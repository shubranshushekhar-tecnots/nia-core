import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "@nia/extract";
import { connect, introspectCatalog } from "@nia/extract/mssql";
import { PlanometryClient } from "../planometry/client.js";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";
import { KeyedSemaphore } from "./concurrency.js";
import { runSync } from "./runSync.js";

/**
 * Mandatory Phase 2 integration tests (docs/plans/planometry-integration.md
 * "Mandatory tests") proving the full extract -> spool -> upload ->
 * complete/failed pipeline against a real SQL Server instance and a real
 * (non-mocked) Planometry push server — none of these can be meaningfully
 * proven against mocks. Requires the throwaway harness running first:
 *   packages/extract/scripts/harness/start.sh
 * Excluded from `pnpm test` (vitest.config.ts); run explicitly with
 * `pnpm test:integration` (vitest.integration.config.ts).
 */

const HOST = process.env.NIA_EXTRACT_MSSQL_HOST ?? "localhost";
const PORT = Number(process.env.NIA_EXTRACT_MSSQL_PORT ?? "14330");
const USER = process.env.NIA_EXTRACT_MSSQL_USER ?? "sa";
const PASSWORD = process.env.NIA_EXTRACT_MSSQL_PASSWORD ?? "N!aExtractTest_2026";
const DATABASE = process.env.NIA_EXTRACT_MSSQL_DATABASE ?? "nia_extract_test";

type Pool = Awaited<ReturnType<typeof connect>>;

/** True if a request whose submitted batch text contains `textFragment` is currently executing (sys.dm_exec_requests), excluding the caller's own session — same helper as packages/extract's own mandatory integration suite (mssql.integration.test.ts). */
async function queryTextRunning(pool: Pool, textFragment: string): Promise<boolean> {
  const result = await pool
    .request()
    .input("frag", `%${textFragment}%`)
    .query<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM sys.dm_exec_requests r
       CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE t.text LIKE @frag AND r.session_id <> @@SPID`,
    );
  return (result.recordset[0]?.c ?? 0) > 0;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

const connectionId = "conn-integration";
const sqlConfig = { server: HOST, port: PORT, database: DATABASE, user: USER, password: PASSWORD, encrypt: true, trustServerCertificate: true };
const masterKey = randomBytes(MASTER_KEY_LENGTH_BYTES);

describe("runSync integration (throwaway SQL Server harness + fake Planometry server)", () => {
  let pool: Pool;
  let catalog: Catalog;

  beforeAll(async () => {
    pool = await connect(sqlConfig);
    catalog = await introspectCatalog(pool, "UTC");
  });

  afterAll(async () => {
    await pool.close();
  });

  let server: FakePlanometryServer;
  let client: PlanometryClient;
  let spoolDir: string;

  beforeEach(async () => {
    server = await FakePlanometryServer.start();
    client = new PlanometryClient({ baseUrl: server.baseUrl, agentKey: "k", agentVersion: "0.0.1" });
    spoolDir = await mkdtemp(path.join(tmpdir(), "nia-agent-integration-"));
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(spoolDir, { recursive: true, force: true });
  });

  function freshSemaphores() {
    return { connectionSemaphore: new KeyedSemaphore(1), hostSemaphore: new KeyedSemaphore(1) };
  }

  it("runs an end-to-end sync against the real SQL Server + fake server with an exact row count match", async () => {
    server.enqueueWork(connectionId, { runId: "run-rowcount", request: { table: "dbo.widgets", columns: ["id", "name"], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;

    await runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, ...freshSemaphores() });

    expect(server.getRun("run-rowcount")).toMatchObject({ totalRows: 3, chunkCount: 1, complete: { totalRows: 3, totalChunks: 1 } });
    expect(existsSync(path.join(spoolDir, "run-rowcount"))).toBe(false);
  });

  it("ignores a duplicate chunk ack instead of double-counting it", async () => {
    server.enqueueWork(connectionId, { runId: "run-dup", request: { table: "dbo.widgets", columns: ["id"], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;

    await runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, ...freshSemaphores() });
    expect(server.getRun("run-dup")?.totalRows).toBe(3);

    // Re-deliver the already-recorded seq with a different row count — must be a no-op re-ack, never a double-count.
    await client.pushChunk("run-dup", 0, 999, Buffer.from("duplicate"));
    expect(server.getRun("run-dup")?.totalRows).toBe(3);
  });

  it("retries a dropped chunk with the same seq against the real extract pipeline", async () => {
    server.enqueueWork(connectionId, { runId: "run-retry", request: { table: "dbo.widgets", columns: ["id"], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;
    server.setRunFaults("run-retry", { dropOnFirstAttempt: new Set([0]) });

    await runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, ...freshSemaphores() });

    expect(server.getRun("run-retry")).toMatchObject({ totalRows: 3, chunkCount: 1 });
    expect(existsSync(path.join(spoolDir, "run-retry"))).toBe(false);
  });

  it("a 409 stops the run and cleans up its spool files without reporting complete/failed", async () => {
    server.enqueueWork(connectionId, { runId: "run-409", request: { table: "dbo.widgets", columns: ["id"], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;
    server.setRunFaults("run-409", { force409: new Set([0]) });

    await runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, ...freshSemaphores() });

    const run = server.getRun("run-409");
    expect(run?.complete).toBeUndefined();
    expect(run?.failed).toBeUndefined();
    expect(existsSync(path.join(spoolDir, "run-409"))).toBe(false);
  });

  it("the slow view's heartbeats keep the sync alive while waiting for its first row", async () => {
    server.enqueueWork(connectionId, { runId: "run-heartbeat", request: { table: "dbo.vw_slow", columns: [], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;

    await runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, heartbeatIntervalMs: 1000, ...freshSemaphores() });

    const run = server.getRun("run-heartbeat");
    expect(run?.heartbeatCount).toBeGreaterThan(0);
    expect(run?.complete).toEqual({ totalRows: 1, totalChunks: 1 });
  }, 60_000);

  it("confirms the DB query is closed before any chunk upload begins", async () => {
    server.enqueueWork(connectionId, { runId: "run-closed", request: { table: "dbo.vw_slow", columns: [], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;

    let firstPushAt: number | undefined;
    const pushChunkSpy = vi.spyOn(client, "pushChunk");
    pushChunkSpy.mockImplementation(async (...args) => {
      firstPushAt ??= Date.now();
      return PlanometryClient.prototype.pushChunk.apply(client, args as never);
    });

    const syncPromise = runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, ...freshSemaphores() });

    const started = await waitUntil(() => queryTextRunning(pool, "vw_slow"), 15_000);
    expect(started).toBe(true);

    let queryClosedAt: number | undefined;
    await waitUntil(async () => {
      const running = await queryTextRunning(pool, "vw_slow");
      if (!running && queryClosedAt === undefined) queryClosedAt = Date.now();
      return !running;
    }, 15_000);

    await syncPromise;

    expect(queryClosedAt).toBeDefined();
    expect(firstPushAt).toBeDefined();
    expect(firstPushAt!).toBeGreaterThanOrEqual(queryClosedAt!);
  }, 60_000);

  it("a shutdown mid-sync reports the run failed to Planometry and cleans up its spool", async () => {
    server.enqueueWork(connectionId, { runId: "run-abort", request: { table: "dbo.vw_slow", columns: [], filter: [] } });
    const work = (await client.pollWork(connectionId)).work!;
    const controller = new AbortController();

    const syncPromise = runSync({ client, work, catalog, sqlConfig, connectionId, spoolDir, masterKey, signal: controller.signal, ...freshSemaphores() });

    const started = await waitUntil(() => queryTextRunning(pool, "vw_slow"), 15_000);
    expect(started).toBe(true);

    controller.abort();
    await syncPromise;

    const run = server.getRun("run-abort");
    expect(run?.failed).toEqual({ error: "aborted" });
    expect(run?.complete).toBeUndefined();
    expect(existsSync(path.join(spoolDir, "run-abort"))).toBe(false);

    const stopped = await waitUntil(async () => !(await queryTextRunning(pool, "vw_slow")), 5_000);
    expect(stopped).toBe(true);
  }, 60_000);
});
