import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStatus, readState, recordAgentStarted, recordCatalogFingerprint, recordSyncComplete, recordSyncFailed } from "./state.js";

describe("agent state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty state when no file exists yet", () => {
    expect(readState(dir)).toEqual({ connections: {} });
    expect(getStatus(dir)).toEqual({ startedAt: undefined, uptimeSeconds: undefined, connections: {} });
  });

  it("records agent start and reports uptime", () => {
    recordAgentStarted(dir);
    const status = getStatus(dir);
    expect(status.startedAt).toBeDefined();
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("records sync completion, clearing any prior error", () => {
    recordSyncFailed("conn-1", "boom", dir);
    recordSyncComplete("conn-1", 42, dir);

    const status = getStatus(dir);
    expect(status.connections["conn-1"]).toMatchObject({ lastSyncRows: 42 });
    expect(status.connections["conn-1"]!.lastError).toBeUndefined();
  });

  it("records sync failure without disturbing other connections", () => {
    recordSyncComplete("conn-1", 10, dir);
    recordSyncFailed("conn-2", "timeout", dir);

    const status = getStatus(dir);
    expect(status.connections["conn-1"]).toMatchObject({ lastSyncRows: 10 });
    expect(status.connections["conn-2"]).toMatchObject({ lastError: "timeout" });
  });

  it("records catalog fingerprint independently of sync state", () => {
    recordCatalogFingerprint("conn-1", "abc123", dir);
    recordSyncComplete("conn-1", 5, dir);

    const status = getStatus(dir);
    expect(status.connections["conn-1"]).toMatchObject({ catalogFingerprint: "abc123", lastSyncRows: 5 });
  });
});
