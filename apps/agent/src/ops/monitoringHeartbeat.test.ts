import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMonitoringHeartbeatPayload, MonitoringHeartbeatScheduler, sendMonitoringHeartbeat } from "./monitoringHeartbeat.js";
import type { AgentState } from "./state.js";

describe("buildMonitoringHeartbeatPayload", () => {
  it("includes only agent version, connection ids, last-success times, and error counts", () => {
    const state: AgentState = {
      startedAt: "2026-01-01T00:00:00.000Z",
      connections: {
        "conn-1": { lastSyncAt: "2026-01-01T01:00:00.000Z", lastSyncRows: 12345, lastPollAt: "2026-01-01T01:05:00.000Z", consecutiveFailures: 0 },
        "conn-2": { lastErrorAt: "2026-01-01T02:00:00.000Z", lastError: "connection refused to host 10.0.0.5 as user sa", consecutiveFailures: 4 },
      },
    };

    const payload = buildMonitoringHeartbeatPayload("1.2.3", state);

    expect(payload.agentVersion).toBe("1.2.3");
    expect(payload.connections).toEqual([
      { id: "conn-1", lastSyncAt: "2026-01-01T01:00:00.000Z", lastPollAt: "2026-01-01T01:05:00.000Z", errorCount: 0 },
      { id: "conn-2", lastSyncAt: undefined, lastPollAt: undefined, errorCount: 4 },
    ]);

    // No row data (lastSyncRows) or potentially sensitive free-text (lastError, which may
    // embed hostnames/usernames) ever reaches the payload — asserted on the serialized
    // wire form, not just the typed shape, so a future field addition can't silently leak.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("connection refused");
    expect(serialized).not.toContain("10.0.0.5");
  });

  it("produces an empty connections array for a fresh state", () => {
    const payload = buildMonitoringHeartbeatPayload("1.0.0", { connections: {} });
    expect(payload.connections).toEqual([]);
  });
});

describe("sendMonitoringHeartbeat", () => {
  let server: Server;
  let received: unknown;
  let url: string;

  beforeEach(async () => {
    received = undefined;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = JSON.parse(body);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound AddressInfo");
    url = `http://127.0.0.1:${address.port}/ingest`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs the payload as JSON", async () => {
    const payload = buildMonitoringHeartbeatPayload("1.0.0", { connections: { "conn-1": { consecutiveFailures: 1 } } });
    await sendMonitoringHeartbeat(url, payload);
    expect(received).toEqual(payload);
  });
});

describe("MonitoringHeartbeatScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when heartbeatUrl is unset", () => {
    const getPayload = vi.fn();
    const scheduler = new MonitoringHeartbeatScheduler(undefined, undefined, getPayload);
    scheduler.start();
    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.stop();
    expect(getPayload).not.toHaveBeenCalled();
  });

  it("fires at the configured interval while started, and stops on stop()", async () => {
    const getPayload = vi.fn(() => buildMonitoringHeartbeatPayload("1.0.0", { connections: {} }));
    const send = vi.fn().mockResolvedValue(undefined);

    const scheduler = new MonitoringHeartbeatScheduler("http://127.0.0.1:9/ingest", 30, getPayload, undefined, send);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getPayload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getPayload).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getPayload).toHaveBeenCalledTimes(2);
  });

  it("swallows send errors via onError without throwing", async () => {
    const getPayload = () => buildMonitoringHeartbeatPayload("1.0.0", { connections: {} });
    const send = vi.fn().mockRejectedValue(new Error("network down"));
    const onError = vi.fn();

    const scheduler = new MonitoringHeartbeatScheduler("http://127.0.0.1:9/ingest", 30, getPayload, onError, send);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
