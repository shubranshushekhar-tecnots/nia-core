import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nia/extract/mssql";
import { addConnection } from "./connectionCommands.js";
import { buildReadonlySetupScript } from "./sqlReadonlyScript.js";
import { runDoctor } from "./doctorCommand.js";
import { FakePlanometryServer } from "../testing/fakePlanometryServer.js";

/**
 * Mandatory Phase 3 prep integration test: proves `agent doctor` actually
 * works against a real SQL Server (the readonly login from Slice 1) and a
 * real (fake) Planometry HTTP server — not just mocked unit behavior.
 * Requires the throwaway harness running first:
 * packages/extract/scripts/harness/start.sh
 * Excluded from `pnpm test` (vitest.config.ts); run explicitly with
 * `pnpm test:integration`.
 */

const HOST = process.env.NIA_EXTRACT_MSSQL_HOST ?? "localhost";
const PORT = Number(process.env.NIA_EXTRACT_MSSQL_PORT ?? "14330");
const SA_USER = process.env.NIA_EXTRACT_MSSQL_USER ?? "sa";
const SA_PASSWORD = process.env.NIA_EXTRACT_MSSQL_PASSWORD ?? "N!aExtractTest_2026";
const DATABASE = process.env.NIA_EXTRACT_MSSQL_DATABASE ?? "nia_extract_test";

const TEST_LOGIN = "nia_doctor_itest";
// Throwaway test-container password only, torn down with the login at the
// end of this suite — not a real secret.
const TEST_PASSWORD = "N!aDoctorItest_2026";

type Pool = Awaited<ReturnType<typeof connect>>;

function sqlBracket(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

async function dropTestLogin(pool: Pool): Promise<void> {
  await pool.request().batch(`
    USE ${sqlBracket(DATABASE)};
    IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${TEST_LOGIN}')
      DROP USER ${sqlBracket(TEST_LOGIN)};
    USE [master];
    IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${TEST_LOGIN}')
      DROP LOGIN ${sqlBracket(TEST_LOGIN)};
  `);
}

describe("runDoctor against a real SQL Server + fake Planometry", () => {
  let saPool: Pool;
  const dirs: string[] = [];
  const servers: FakePlanometryServer[] = [];

  beforeAll(async () => {
    saPool = await connect({ server: HOST, port: PORT, database: DATABASE, user: SA_USER, password: SA_PASSWORD, encrypt: false });
    await dropTestLogin(saPool); // clean slate in case a previous run left the login behind
    const script = buildReadonlySetupScript({ loginName: TEST_LOGIN, databases: [DATABASE], withCancelVisibility: true }).replace(
      "<CHANGE_ME_STRONG_PASSWORD>",
      TEST_PASSWORD,
    );
    await saPool.request().batch(script);
  });

  afterAll(async () => {
    await dropTestLogin(saPool);
    await saPool.close();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function newDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "nia-agent-doctor-itest-"));
    dirs.push(dir);
    return dir;
  }

  async function newFakeServer(): Promise<FakePlanometryServer> {
    const server = await FakePlanometryServer.start();
    servers.push(server);
    return server;
  }

  it("reports all checks passing for a correctly configured connection", async () => {
    const dir = await newDir();
    const fake = await newFakeServer();
    addConnection(
      {
        id: "conn-ok",
        label: "Healthy",
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: TEST_LOGIN,
        password: TEST_PASSWORD,
        encrypt: false,
        planometryBaseUrl: fake.baseUrl,
        agentKey: "any-key",
      },
      dir,
    );

    const [report] = await runDoctor("conn-ok", dir);
    const failing = report!.checks.filter((c) => !c.pass);
    expect(failing).toEqual([]);
    expect(report!.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "SQL Server reachable",
        "TLS mode works",
        "login credentials accepted",
        "can read / see catalog",
        "login can't write",
        "sys.dm_exec_requests visible (cancel confirmation)",
        "spool directory free disk space",
        "Planometry URL reachable",
        "clock skew",
        "agent key accepted",
      ]),
    );
  });

  it("fails only the login check on a wrong password, and skips permission checks that need a pool", async () => {
    const dir = await newDir();
    const fake = await newFakeServer();
    addConnection(
      {
        id: "conn-bad-password",
        label: "Bad password",
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: TEST_LOGIN,
        password: "definitely-the-wrong-password",
        encrypt: false,
        planometryBaseUrl: fake.baseUrl,
        agentKey: "any-key",
      },
      dir,
    );

    const [report] = await runDoctor("conn-bad-password", dir);
    const byName = Object.fromEntries(report!.checks.map((c) => [c.name, c]));
    expect(byName["SQL Server reachable"]?.pass).toBe(true);
    expect(byName["TLS mode works"]?.pass).toBe(true);
    expect(byName["login credentials accepted"]?.pass).toBe(false);
    expect(byName["login credentials accepted"]?.fix).toBeDefined();
    expect(byName["can read / see catalog"]).toBeUndefined();
    expect(byName["login can't write"]).toBeUndefined();
    expect(byName["sys.dm_exec_requests visible (cancel confirmation)"]).toBeUndefined();
    expect(byName["spool directory free disk space"]?.pass).toBe(true);
    expect(byName["agent key accepted"]?.pass).toBe(true);
  });

  it("fails agent-key-accepted on a wrong agent key, without affecting SQL checks", async () => {
    const dir = await newDir();
    const fake = await newFakeServer();
    fake.requireAgentKey("the-right-key");
    addConnection(
      {
        id: "conn-bad-key",
        label: "Bad agent key",
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: TEST_LOGIN,
        password: TEST_PASSWORD,
        encrypt: false,
        planometryBaseUrl: fake.baseUrl,
        agentKey: "the-wrong-key",
      },
      dir,
    );

    const [report] = await runDoctor("conn-bad-key", dir);
    const byName = Object.fromEntries(report!.checks.map((c) => [c.name, c]));
    expect(byName["login credentials accepted"]?.pass).toBe(true);
    expect(byName["login can't write"]?.pass).toBe(true);
    expect(byName["agent key accepted"]?.pass).toBe(false);
    expect(byName["agent key accepted"]?.fix).toMatch(/regenerate|update/);
    expect(JSON.stringify(byName["agent key accepted"])).not.toContain("the-wrong-key");
  });
});
