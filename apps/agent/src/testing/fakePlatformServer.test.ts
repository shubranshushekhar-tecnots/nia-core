import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/store.js";
import { pair, PairingRejectedError } from "../link/pairing.js";
import { SetupClient, SetupNotFoundError } from "../link/setupClient.js";
import { HttpAgentTransport } from "../link/transport.js";
import { FakePlatformServer } from "./fakePlatformServer.js";

/**
 * Proves the fake platform server's wire shapes actually satisfy apps/
 * agent's own real client code (`pair`, `HttpAgentTransport`,
 * `SetupClient`) over real HTTP — a cheap, fast substitute for finding
 * out only inside the much slower Windows CI run that a field name or
 * status code drifted from services/agent-bridge/src/app.ts.
 *
 * `SetupManager.apply()`'s own pipeline (reading the real source table,
 * building the mapping, pushing to a real Planometry endpoint) is
 * exercised separately, against a real SQL Server + FakePlanometryServer
 * — not re-tested here.
 */
describe("FakePlatformServer", () => {
  let dir: string;
  let server: FakePlatformServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-fake-platform-"));
    server = await FakePlatformServer.start({ holdMs: 50 });
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await server.close();
  });

  it("pairs with a valid composite code and the resulting key check-in-authenticates", async () => {
    const { pairingCodeId, code, composite } = server.registerPairingCode();
    const result = await pair({ code: composite, url: server.baseUrl }, dir);
    expect(result.agentId).toBeTruthy();

    const config = loadConfig(dir);
    expect(config.link?.agentId).toBe(result.agentId);
    expect(config.link?.platformUrl).toBe(server.baseUrl);

    const agent = server.getAgent(result.agentId);
    expect(agent).toBeDefined();

    // A second attempt to use the same (now-consumed) code is refused.
    await expect(pair({ code: composite, url: server.baseUrl }, dir)).rejects.toThrow(PairingRejectedError);
    void pairingCodeId;
    void code;
  });

  it("refuses a well-formed but wrong/expired code with a plain message, not a crash", async () => {
    server.registerPairingCode("right-code");
    await expect(pair({ code: `${randomUUID()}.wrong-code`, url: server.baseUrl }, dir)).rejects.toThrow(
      PairingRejectedError,
    );
  });

  it("check-in round-trips tasks, acknowledged run ids, and setup summaries", async () => {
    const { composite } = server.registerPairingCode();
    const { agentId } = await pair({ code: composite, url: server.baseUrl }, dir);
    const agentKeyRef = loadConfig(dir).link!.agentKeyRef;
    const { LocalSecretStore } = await import("../secrets/store.js");
    const { loadOrCreateMasterKey } = await import("../secrets/keyfile.js");
    const agentKey = (new LocalSecretStore(loadOrCreateMasterKey(dir), dir).get(agentKeyRef) as { agentKey: string }).agentKey;

    server.queueTask(agentId, { id: "task-1", kind: "test_connection", localConnectionId: "conn-1" });
    const setupId = server.publishSetup(agentId, {
      workflowId: "wf-1",
      wantedVersion: 1,
      setup: null,
      localSourceConnectionId: null,
      destination: { connectorId: "planometry-table", config: { address: "http://localhost:1/x" } },
      secret: { pushKey: "pk-1" },
    });

    const transport = new HttpAgentTransport({ platformUrl: server.baseUrl, agentKey });
    try {
      const response = await transport.checkIn({
        agentVersion: "0.0.5",
        hostName: "ci-runner",
        noHold: true,
        runReports: [
          {
            runId: "11111111-1111-1111-1111-111111111111",
            jobId: "job-1",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            status: "ok",
            rowsSent: 1,
            rowsDeleted: 0,
            parts: 1,
          },
        ],
      });
      expect(response.tasks).toEqual([{ id: "task-1", kind: "test_connection", localConnectionId: "conn-1" }]);
      expect(response.acknowledgedRunIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
      expect(response.setups).toEqual([{ id: setupId, workflowId: "wf-1", wantedVersion: 1, appliedVersion: 0, removed: false }]);

      // Tasks are consumed on delivery — a second check-in sees none.
      const second = await transport.checkIn({ agentVersion: "0.0.5", hostName: "ci-runner", noHold: true });
      expect(second.tasks).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it("a check-in without noHold still returns promptly once a task is queued mid-wait (no fixed-hold stall)", async () => {
    const { composite } = server.registerPairingCode();
    const { agentId } = await pair({ code: composite, url: server.baseUrl }, dir);
    const agentKeyRef = loadConfig(dir).link!.agentKeyRef;
    const { LocalSecretStore } = await import("../secrets/store.js");
    const { loadOrCreateMasterKey } = await import("../secrets/keyfile.js");
    const agentKey = (new LocalSecretStore(loadOrCreateMasterKey(dir), dir).get(agentKeyRef) as { agentKey: string }).agentKey;

    const transport = new HttpAgentTransport({ platformUrl: server.baseUrl, agentKey });
    try {
      const checkInPromise = transport.checkIn({ agentVersion: "0.0.5", hostName: "ci-runner" });
      server.queueTask(agentId, { id: "task-2", kind: "list_tables", localConnectionId: "conn-2" });
      const response = await checkInPromise;
      expect(response.tasks).toEqual([{ id: "task-2", kind: "list_tables", localConnectionId: "conn-2" }]);
    } finally {
      await transport.close();
    }
  });

  it("SetupClient fetches a published setup and its secret, then reports applied/rejected", async () => {
    const { composite } = server.registerPairingCode();
    const { agentId } = await pair({ code: composite, url: server.baseUrl }, dir);
    const agentKeyRef = loadConfig(dir).link!.agentKeyRef;
    const { LocalSecretStore } = await import("../secrets/store.js");
    const { loadOrCreateMasterKey } = await import("../secrets/keyfile.js");
    const agentKey = (new LocalSecretStore(loadOrCreateMasterKey(dir), dir).get(agentKeyRef) as { agentKey: string }).agentKey;

    const published = {
      sourceConnectionId: "src-1",
      sourceTable: "dbo.Orders",
      destinationConnectionId: "dest-1",
      columns: [],
      mapping: [],
      filter: [],
      params: {},
      mode: "replace" as const,
      schedule: "* * * * *",
    };
    const setupId = server.publishSetup(agentId, {
      workflowId: "wf-2",
      wantedVersion: 1,
      setup: published,
      localSourceConnectionId: "local-conn-1",
      destination: { connectorId: "planometry-table", config: { address: "http://localhost:1/x" } },
      secret: { pushKey: "pk-2" },
    });

    const client = new SetupClient({ platformUrl: server.baseUrl, agentKey });
    try {
      const fetched = await client.fetchSetup(setupId);
      expect(fetched).toEqual({
        id: setupId,
        workflowId: "wf-2",
        wantedVersion: 1,
        setup: published,
        localSourceConnectionId: "local-conn-1",
        destination: { connectorId: "planometry-table", config: { address: "http://localhost:1/x" } },
      });

      const secret = await client.fetchSecret(setupId);
      expect(secret).toEqual({ pushKey: "pk-2" });

      await client.reportApplied(setupId, 1);
      expect(server.getAgent(agentId)?.setups.get(setupId)).toMatchObject({ appliedVersion: 1, rejectionReason: null });

      await client.reportRejected(setupId, "destination unreachable");
      expect(server.getAgent(agentId)?.setups.get(setupId)).toMatchObject({
        appliedVersion: 1,
        rejectionReason: "destination unreachable",
      });

      await expect(client.fetchSetup("no-such-setup")).rejects.toBeInstanceOf(SetupNotFoundError);
    } finally {
      await client.close();
    }
  });
});
