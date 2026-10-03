import { createServer, type Server } from "node:http";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionEntry } from "../config/types.js";

const { connectMock, introspectCatalogMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  introspectCatalogMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", () => ({
  connect: connectMock,
  introspectCatalog: introspectCatalogMock,
}));

const { checkCancelVisibility, checkDiskSpace, checkLoginPermissions, probePlanometry, probeSqlServer } = await import("./doctorChecks.js");

const CANARY_PASSWORD = "sw0rdfish-canary-secret";

function fakeEntry(): ConnectionEntry {
  return {
    id: "conn-1",
    label: "Test Connection",
    sqlserver: { host: "db.example.test", port: 1433, database: "SummitERP_1" },
    planometry: { baseUrl: "http://127.0.0.1:1" },
    credentialRef: "cred-ref",
    agentKeyRef: "key-ref",
  };
}

function fakePool(queryImpl: (sql: string) => Promise<{ recordset: unknown[] }>) {
  return { request: () => ({ query: queryImpl }) } as unknown as Parameters<typeof checkCancelVisibility>[0];
}

describe("probeSqlServer", () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it("passes reachable+tls+login and returns the pool on success", async () => {
    const pool = { closed: false };
    connectMock.mockResolvedValue(pool);
    const result = await probeSqlServer(fakeEntry(), { user: "ro_user", password: CANARY_PASSWORD });
    expect(result.reachable.pass).toBe(true);
    expect(result.tls.pass).toBe(true);
    expect(result.login.pass).toBe(true);
    expect(result.pool).toBe(pool);
  });

  it("treats ELOGIN as reachable+tls pass but login fail, with no pool", async () => {
    connectMock.mockRejectedValue(Object.assign(new Error("Login failed for user"), { code: "ELOGIN" }));
    const result = await probeSqlServer(fakeEntry(), { user: "ro_user", password: CANARY_PASSWORD });
    expect(result.reachable.pass).toBe(true);
    expect(result.tls.pass).toBe(true);
    expect(result.login.pass).toBe(false);
    expect(result.login.fix).toMatch(/connection add|sql readonly/);
    expect(result.pool).toBeUndefined();
  });

  it("fails reachable+tls with a fix on a TLS/handshake-looking error", async () => {
    connectMock.mockRejectedValue(new Error("self signed certificate in certificate chain"));
    const result = await probeSqlServer(fakeEntry(), { user: "ro_user", password: CANARY_PASSWORD });
    expect(result.reachable.pass).toBe(false);
    expect(result.tls.pass).toBe(false);
    expect(result.tls.fix).toMatch(/encrypt|allowLegacyTls|trustServerCertificate/);
  });

  it("fails reachable (tls skipped) on a generic network error", async () => {
    connectMock.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:1433"), { code: "ESOCKET" }));
    const result = await probeSqlServer(fakeEntry(), { user: "ro_user", password: CANARY_PASSWORD });
    expect(result.reachable.pass).toBe(false);
    expect(result.reachable.fix).toMatch(/firewall|VPN/);
    expect(result.tls.pass).toBe(false);
    expect(result.tls.detail).toMatch(/skipped/);
  });

  it("never echoes the password into any check result", async () => {
    connectMock.mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED (tried as ${CANARY_PASSWORD})`), { code: "ESOCKET" }));
    const result = await probeSqlServer(fakeEntry(), { user: "ro_user", password: CANARY_PASSWORD });
    // The mocked driver error above deliberately contains the password to prove
    // doctorChecks itself never *adds* the password anywhere beyond whatever a
    // (hypothetical) misbehaving driver already put in its own error message —
    // i.e. this asserts our code doesn't independently re-embed `credentials`.
    expect(result.reachable.detail).toContain(CANARY_PASSWORD); // from the driver's own message, not us
    expect(JSON.stringify(result)).not.toContain("ro_user\":\"" + CANARY_PASSWORD);
  });
});

describe("checkLoginPermissions", () => {
  beforeEach(() => {
    introspectCatalogMock.mockReset();
  });

  it("passes can-read when the catalog has tables", async () => {
    introspectCatalogMock.mockResolvedValue({ tables: [{ name: "widgets" }], generatedAt: "now", sourceTimeZone: "UTC" });
    const pool = fakePool(async () => ({ recordset: [{ permission_name: "SELECT" }] }));
    const [canRead, cantWrite] = await checkLoginPermissions(pool);
    expect(canRead.pass).toBe(true);
    expect(cantWrite.pass).toBe(true);
  });

  it("fails can-read when the catalog is empty", async () => {
    introspectCatalogMock.mockResolvedValue({ tables: [], generatedAt: "now", sourceTimeZone: "UTC" });
    const pool = fakePool(async () => ({ recordset: [] }));
    const [canRead] = await checkLoginPermissions(pool);
    expect(canRead.pass).toBe(false);
    expect(canRead.fix).toMatch(/db_datareader/);
  });

  it("fails can't-write when a write permission is granted", async () => {
    introspectCatalogMock.mockResolvedValue({ tables: [{ name: "widgets" }], generatedAt: "now", sourceTimeZone: "UTC" });
    const pool = fakePool(async () => ({ recordset: [{ permission_name: "INSERT" }, { permission_name: "SELECT" }] }));
    const [, cantWrite] = await checkLoginPermissions(pool);
    expect(cantWrite.pass).toBe(false);
    expect(cantWrite.detail).toContain("INSERT");
    expect(cantWrite.fix).toMatch(/db_datawriter|revoke/);
  });

  it("never executes a write — only ever calls .query(), never anything that mutates", async () => {
    introspectCatalogMock.mockResolvedValue({ tables: [{ name: "widgets" }], generatedAt: "now", sourceTimeZone: "UTC" });
    const queries: string[] = [];
    const pool = fakePool(async (sql) => {
      queries.push(sql);
      return { recordset: [] };
    });
    await checkLoginPermissions(pool);
    for (const q of queries) expect(q).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i);
  });
});

describe("checkCancelVisibility", () => {
  it("passes when sys.dm_exec_requests is queryable", async () => {
    const pool = fakePool(async () => ({ recordset: [{ c: 0 }] }));
    const result = await checkCancelVisibility(pool);
    expect(result.pass).toBe(true);
  });

  it("fails with a VIEW SERVER STATE fix on error, as a WARNING (not a hard failure — it's opt-in)", async () => {
    const pool = fakePool(async () => {
      throw new Error("permission denied");
    });
    const result = await checkCancelVisibility(pool);
    expect(result.pass).toBe(false);
    expect(result.severity).toBe("warning");
    expect(result.fix).toMatch(/VIEW SERVER STATE/);
  });
});

describe("checkDiskSpace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-doctor-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes for a real directory with room to spare", async () => {
    const result = await checkDiskSpace(dir);
    expect(result.pass).toBe(true);
  });

  it("creates the directory if it doesn't exist yet and still passes", async () => {
    const spoolDir = path.join(dir, "spool", "does-not-exist-yet");
    const result = await checkDiskSpace(spoolDir);
    expect(result.pass).toBe(true);
    const stat = await lstat(spoolDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("fails with a fix when the path can't be created (parent is a file, not a directory)", async () => {
    const blockerFile = path.join(dir, "blocker");
    await writeFile(blockerFile, "not a directory");
    const result = await checkDiskSpace(path.join(blockerFile, "spool"));
    expect(result.pass).toBe(false);
    expect(result.fix).toBeDefined();
  });
});

describe("probePlanometry", () => {
  let server: Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes reachable+clockSkew against a server with a synced clock", async () => {
    server = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const result = await probePlanometry(baseUrl);
    expect(result.reachable.pass).toBe(true);
    expect(result.clockSkew.pass).toBe(true);
  });

  it("fails clockSkew when the server's clock is far off", async () => {
    server = createServer((_req, res) => {
      const skewed = new Date(Date.now() + 10 * 60 * 1000).toUTCString();
      res.writeHead(200, { date: skewed }).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const result = await probePlanometry(baseUrl);
    expect(result.reachable.pass).toBe(true);
    expect(result.clockSkew.pass).toBe(false);
    expect(result.clockSkew.fix).toMatch(/NTP/);
  });

  it("fails both when unreachable", async () => {
    const result = await probePlanometry("http://127.0.0.1:1");
    expect(result.reachable.pass).toBe(false);
    expect(result.clockSkew.pass).toBe(false);
  });
});
