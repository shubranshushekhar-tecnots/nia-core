import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "@nia/extract";
import type { NdjsonWriter } from "@nia/extract";

const connectMock = vi.fn();
const introspectCatalogMock = vi.fn();
const streamExtractMock = vi.fn();
vi.mock("@nia/extract/mssql", () => ({
  connect: (...args: unknown[]) => connectMock(...args),
  introspectCatalog: (...args: unknown[]) => introspectCatalogMock(...args),
  streamExtract: (...args: unknown[]) => streamExtractMock(...args),
}));

const { runAgentLoop } = await import("./agentLoop.js");
const { getStatus } = await import("./ops/state.js");
const { Logger } = await import("./ops/logger.js");
const { saveConfig } = await import("./config/store.js");
const { LocalSecretStore } = await import("./secrets/store.js");
const { loadOrCreateMasterKey } = await import("./secrets/keyfile.js");
const { FakePlanometryServer } = await import("./testing/fakePlanometryServer.js");

const catalog: Catalog = { generatedAt: "now", sourceTimeZone: "UTC", tables: [] };

describe("runAgentLoop", () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof FakePlanometryServer.start>>;
  let fakePool: { close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-loop-"));
    server = await FakePlanometryServer.start();
    server.setPollAfterSeconds(0);

    fakePool = { close: vi.fn().mockResolvedValue(undefined) };
    connectMock.mockReset().mockResolvedValue(fakePool);
    introspectCatalogMock.mockReset().mockResolvedValue(catalog);
    streamExtractMock.mockReset();
  });

  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function setUpConnection(id: string): void {
    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    const credentialRef = secrets.put({ user: "u", password: "p" });
    const agentKeyRef = secrets.put({ agentKey: "k" });
    saveConfig(
      {
        version: 1,
        connections: [
          {
            id,
            label: id,
            sqlserver: { host: "db.internal", database: "sales" },
            planometry: { baseUrl: server.baseUrl },
            credentialRef,
            agentKeyRef,
          },
        ],
      },
      dir,
    );
  }

  it("polls, syncs, and records state for a successful run, stopping cleanly on abort", async () => {
    setUpConnection("conn-1");
    server.enqueueWork("conn-1", { runId: "run-1", request: { table: "t", columns: ["id"], filter: [] } });
    streamExtractMock.mockImplementation(async (_pool: unknown, _catalog: unknown, _req: unknown, writer: NdjsonWriter) => {
      writer.writeColumns([{ name: "id", type: "number" }]);
      writer.writeRow([1]);
      writer.writeEnd();
    });

    const controller = new AbortController();
    const logger = new Logger(path.join(dir, "logs"));
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal, logger });

    await vi.waitFor(() => expect(server.getRun("run-1")?.complete).toBeDefined());
    controller.abort();
    await loop;

    const status = getStatus(dir);
    expect(status.startedAt).toBeDefined();
    expect(status.connections["conn-1"]).toMatchObject({ lastSyncRows: 1 });
    expect(status.connections["conn-1"]!.lastPollAt).toBeDefined();
  });

  it("records a sync failure when the extract itself errors", async () => {
    setUpConnection("conn-1");
    server.enqueueWork("conn-1", { runId: "run-fail", request: { table: "t", columns: ["id"], filter: [] } });
    streamExtractMock.mockImplementation(async (_pool: unknown, _catalog: unknown, _req: unknown, writer: NdjsonWriter) => {
      writer.writeColumns([{ name: "id", type: "number" }]);
      writer.writeError("query timed out");
    });

    const controller = new AbortController();
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal });

    await vi.waitFor(() => expect(server.getRun("run-fail")?.failed).toBeDefined());
    controller.abort();
    await loop;

    const status = getStatus(dir);
    expect(status.connections["conn-1"]).toMatchObject({ lastError: "query timed out" });
  });

  it("records a sync failure when connecting to the database throws", async () => {
    setUpConnection("conn-1");
    server.enqueueWork("conn-1", { runId: "run-connect-fail", request: { table: "t", columns: ["id"], filter: [] } });
    introspectCatalogMock.mockRejectedValueOnce(new Error("db unreachable"));

    const controller = new AbortController();
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal });

    await vi.waitFor(() => expect(getStatus(dir).connections["conn-1"]?.lastError).toBeDefined());
    controller.abort();
    await loop;

    expect(getStatus(dir).connections["conn-1"]).toMatchObject({ lastError: "db unreachable" });
  });

  it("stops promptly on abort with no connections configured", async () => {
    const controller = new AbortController();
    const loop = runAgentLoop({ dir, agentVersion: "0.0.1", signal: controller.signal });
    controller.abort();
    await loop;
    expect(getStatus(dir).startedAt).toBeDefined();
  });
});
