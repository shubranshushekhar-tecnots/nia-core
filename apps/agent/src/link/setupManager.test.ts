import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog, CatalogTable } from "@nia/extract";
import type { SyncJobEntry } from "../config/types.js";
import type { FetchedSetup } from "./setupClient.js";
import type { SetupClientLike } from "./setupManager.js";

const { connectMock, introspectCatalogMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  introspectCatalogMock: vi.fn(),
}));

vi.mock("@nia/extract/mssql", () => ({
  connect: connectMock,
  introspectCatalog: introspectCatalogMock,
}));

const { addConnection } = await import("../cli/connectionCommands.js");
const { listJobs, updateJob } = await import("../cli/jobCommands.js");
const { loadConfig, saveConfig, upsertJob } = await import("../config/store.js");
const { allowDestinationHost } = await import("../destinations/allowedHosts.js");
const { loadOrCreateMasterKey } = await import("../secrets/keyfile.js");
const { LocalSecretStore } = await import("../secrets/store.js");
const { SetupManager } = await import("./setupManager.js");

function sourceCatalog(table: CatalogTable): Catalog {
  return { generatedAt: new Date().toISOString(), sourceTimeZone: "UTC", tables: [table] };
}

function sourceTable(name: string, columns: CatalogTable["columns"]): CatalogTable {
  return { name, kind: "table", columns, excluded: [] };
}

/** A bare-bones FetchedSetup for an `https-endpoint` destination — no live schema/server needed, unlike a Planometry destination. */
function fetchedHttpsSetup(overrides: Partial<FetchedSetup> = {}): FetchedSetup {
  return {
    id: "setup-1",
    workflowId: "wf-1",
    wantedVersion: 1,
    setup: {
      sourceConnectionId: "platform-conn-1",
      sourceTable: "dbo.Sales",
      destinationConnectionId: "platform-dest-1",
      columns: [],
      mapping: [
        { source: "Id", target: "id" },
        { source: "Name", target: "name" },
      ],
      filter: [],
      params: {},
      mode: "replace",
    },
    localSourceConnectionId: "conn-1",
    destination: { connectorId: "https-endpoint", config: { address: "https://push.example.com/ingest", authMethod: "bearer" } },
    ...overrides,
  };
}

function fakeSetupClient(fetched: FetchedSetup, secret: Record<string, unknown>): SetupClientLike & {
  reportApplied: ReturnType<typeof vi.fn>;
  reportRejected: ReturnType<typeof vi.fn>;
  fetchSecret: ReturnType<typeof vi.fn>;
} {
  return {
    fetchSetup: vi.fn(async () => fetched),
    fetchSecret: vi.fn(async () => secret),
    reportApplied: vi.fn(async () => {}),
    reportRejected: vi.fn(async () => {}),
  };
}

describe("SetupManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-setupmanager-"));
    connectMock.mockReset();
    introspectCatalogMock.mockReset();
    connectMock.mockResolvedValue({ close: async () => {} });
    introspectCatalogMock.mockResolvedValue(
      sourceCatalog(
        sourceTable("dbo.Sales", [
          { name: "Id", type: "number", nullable: false },
          { name: "Name", type: "text", nullable: true },
        ]),
      ),
    );
    addConnection(
      { id: "conn-1", label: "A", host: "h", database: "d", user: "u", password: "p", sourceTimeZone: "UTC", agentKey: "k" },
      dir,
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Allowed: a newer wanted version is applied as a platform-managed job with its secret stored, and a later removal removes the job", async () => {
    allowDestinationHost("push.example.com", dir);
    const setupClient = fakeSetupClient(fetchedHttpsSetup(), { bearerToken: "tok-123" });
    const manager = new SetupManager({ setupClient, dir });

    await manager.handleCheckIn([{ id: "setup-1", workflowId: "wf-1", wantedVersion: 1, appliedVersion: 0, removed: false }]);

    const jobs = listJobs(dir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("setup-1");
    expect(jobs[0]!.platformManaged).toEqual({ setupId: "setup-1", appliedVersion: 1 });
    expect(setupClient.reportApplied).toHaveBeenCalledWith("setup-1", 1);
    expect(setupClient.reportRejected).not.toHaveBeenCalled();

    const masterKey = loadOrCreateMasterKey(dir);
    const secrets = new LocalSecretStore(masterKey, dir);
    expect(secrets.get<{ secret: string }>(jobs[0]!.pushKeyRef!)).toEqual({ secret: "tok-123" });

    // A later check-in marking the same setup removed removes the job.
    await manager.handleCheckIn([{ id: "setup-1", workflowId: "wf-1", wantedVersion: 1, appliedVersion: 1, removed: true }]);
    expect(listJobs(dir)).toHaveLength(0);
  });

  it("Refused: a disallowed destination host is rejected with a reason, nothing is saved, the same version is not retried, and local job update is refused for a platform-managed job", async () => {
    // Note: push.example.com is deliberately never allow-listed here.
    const setupClient = fakeSetupClient(fetchedHttpsSetup({ id: "setup-2" }), { bearerToken: "tok-123" });
    const manager = new SetupManager({ setupClient, dir });

    await manager.handleCheckIn([{ id: "setup-2", workflowId: "wf-1", wantedVersion: 1, appliedVersion: 0, removed: false }]);

    expect(listJobs(dir)).toHaveLength(0);
    expect(setupClient.reportApplied).not.toHaveBeenCalled();
    expect(setupClient.reportRejected).toHaveBeenCalledTimes(1);
    expect(setupClient.reportRejected.mock.calls[0]![1]).toContain("allow-list");
    // The secret is never fetched for a setup that fails a cheaper check first.
    expect(setupClient.fetchSecret).not.toHaveBeenCalled();

    // The same wanted version is not retried on a second check-in.
    await manager.handleCheckIn([{ id: "setup-2", workflowId: "wf-1", wantedVersion: 1, appliedVersion: 0, removed: false }]);
    expect(setupClient.fetchSetup).toHaveBeenCalledTimes(1);
    expect(setupClient.reportRejected).toHaveBeenCalledTimes(1);

    // Local `job update` on a platform-managed job is refused. Saved directly (rather than via
    // a second handleCheckIn) so this assertion exercises the platformManaged guard itself,
    // not updateJob's unrelated, pre-existing "not yet supported for destinationType https" guard
    // (which fires first and would mask the message this scenario is actually about).
    const platformJob: SyncJobEntry = {
      id: "setup-3",
      name: "platform setup wf-1",
      connectionId: "conn-1",
      sourceTable: "dbo.Sales",
      targetUrl: "https://push.planometry.example.com/t/abc",
      strategy: "replace",
      mapping: [{ source: "Id", target: "Id" }],
      targetSchemaSnapshot: { columns: [], keyColumns: [] },
      onNullKey: "stop",
      allowEmptyReplace: false,
      filter: [],
      params: {},
      platformManaged: { setupId: "setup-3", appliedVersion: 1 },
    };
    saveConfig(upsertJob(loadConfig(dir), platformJob), dir);
    expect(listJobs(dir)).toHaveLength(1);

    const updateResult = await updateJob("setup-3", { name: "renamed" }, {}, dir);
    expect(updateResult.ok).toBe(false);
    expect(updateResult.errors?.[0]).toContain("managed from the platform");
  });
});
