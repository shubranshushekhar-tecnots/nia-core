import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMonitoringHeartbeatPayload, type JobHeartbeatSource, MonitoringHeartbeatScheduler, sendMonitoringHeartbeat } from "./monitoringHeartbeat.js";

describe("buildMonitoringHeartbeatPayload", () => {
  it("includes only agent version, job ids, health state, error class, failure count, and times", () => {
    const jobs: JobHeartbeatSource[] = [
      {
        id: "job-1",
        name: "Orders sync",
        state: { lastSuccessAt: "2026-01-01T01:00:00.000Z", lastRunAt: "2026-01-01T01:00:00.000Z", rowsSent: 12345, consecutiveFailures: 0 },
      },
      {
        id: "job-2",
        name: "Customers sync",
        state: {
          lastError: { class: "config", message: "connection refused to host 10.0.0.5 as user sa", at: "2026-01-01T02:00:00.000Z" },
          lastConsoleMessage: "raw planometry 400 body naming a column",
          consecutiveFailures: 4,
        },
      },
    ];

    const payload = buildMonitoringHeartbeatPayload("1.2.3", jobs);

    expect(payload.agentVersion).toBe("1.2.3");
    expect(payload.jobs).toEqual([
      {
        id: "job-1",
        name: "Orders sync",
        state: "ok",
        errorClass: undefined,
        consecutiveFailures: 0,
        lastRunAt: "2026-01-01T01:00:00.000Z",
        lastSuccessAt: "2026-01-01T01:00:00.000Z",
        nextRunAt: undefined,
      },
      {
        id: "job-2",
        name: "Customers sync",
        state: "failing",
        errorClass: "config",
        consecutiveFailures: 4,
        lastRunAt: undefined,
        lastSuccessAt: undefined,
        nextRunAt: undefined,
      },
    ]);

    // No row data (rowsSent), potentially sensitive free-text error messages, or a
    // Planometry 400's raw console message ever reach the payload — asserted on the
    // serialized wire form, not just the typed shape, so a future field addition can't
    // silently leak any of this.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("connection refused");
    expect(serialized).not.toContain("10.0.0.5");
    expect(serialized).not.toContain("raw planometry 400 body");
  });

  it("produces an empty jobs array when there are no jobs", () => {
    const payload = buildMonitoringHeartbeatPayload("1.0.0", []);
    expect(payload.jobs).toEqual([]);
  });

  it("reports a paused job's state as paused even if it also has failures", () => {
    const jobs: JobHeartbeatSource[] = [
      {
        id: "job-1",
        name: "Orders sync",
        state: { consecutiveFailures: 2, paused: { reason: "401 unauthorized", at: "2026-01-01T00:00:00.000Z" } },
      },
    ];
    const payload = buildMonitoringHeartbeatPayload("1.0.0", jobs);
    expect(payload.jobs[0]!.state).toBe("paused");
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
    const payload = buildMonitoringHeartbeatPayload("1.0.0", [{ id: "job-1", name: "Orders sync", state: { consecutiveFailures: 1 } }]);
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
    const getPayload = vi.fn(() => buildMonitoringHeartbeatPayload("1.0.0", []));
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
    const getPayload = () => buildMonitoringHeartbeatPayload("1.0.0", []);
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
