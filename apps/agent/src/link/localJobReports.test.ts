import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../config/store.js";
import { emptyConfig, type ConnectionEntry, type SyncJobEntry } from "../config/types.js";
import { recordJobFailure } from "../ops/state.js";
import { buildLocalJobReports } from "./localJobReports.js";
import { recordRun, pendingReports } from "./runReportOutbox.js";

const SENSITIVE_MESSAGE = "Planometry rejected row id=42 with value 'top secret customer name'";

function connection(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: "conn-1",
    label: "mysql-prod",
    sqlserver: { host: "db.internal", database: "orders" },
    sourceTimeZone: "UTC",
    credentialRef: "cred-1",
    agentKeyRef: "key-1",
    ...overrides,
  };
}

function job(overrides: Partial<SyncJobEntry> = {}): SyncJobEntry {
  return {
    id: "job-1",
    name: "nightly replace",
    connectionId: "conn-1",
    sourceTable: "dbo.orders",
    targetUrl: "https://planometry.example.com/push/orders",
    pushKeyRef: "push-1",
    strategy: "replace",
    mapping: [],
    targetSchemaSnapshot: { columns: [], keyColumns: [] },
    onNullKey: "stop",
    allowEmptyReplace: false,
    filter: [],
    params: {},
    ...overrides,
  };
}

/**
 * Guard (Slice L4 B.11/B.7 allow-list) — this is the one test that proves
 * nothing beyond the documented field sets can ever leave the agent:
 * `LocalJobReport`/`RunReport` are built from a job/job-state/run-outcome
 * fixture that deliberately plants a Planometry rejection message (and a
 * row-adjacent value) in fields the builders must never read
 * (`state.lastError.message`, `state.lastConsoleMessage`, a `rawRow`-style
 * extra field on the run outcome) — `Object.keys(report)` must be exactly
 * the allow-listed set, and no value anywhere in the built objects may
 * contain the planted sensitive text.
 */
describe("local job / run report payload allow-list", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nia-agent-localjobreports-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("buildLocalJobReports never leaks a Planometry rejection message or console text", () => {
    saveConfig({ ...emptyConfig(), connections: [connection()], jobs: [job()] }, dir);

    // Simulate a failed run that stored a raw server message and a console
    // message — both deliberately excluded from JobErrorInfo's allow-listed
    // surface (module doc in ops/state.ts: "never a raw server message").
    recordJobFailure("job-1", { errorClass: "config", message: SENSITIVE_MESSAGE, consoleMessage: SENSITIVE_MESSAGE }, dir);

    const [report] = buildLocalJobReports(dir);
    expect(report).toBeDefined();

    const allowedKeys = new Set([
      "id",
      "name",
      "connectionName",
      "sourceTable",
      "destinationType",
      "destinationHost",
      "mode",
      "schedule",
      "state",
      "errorClass",
      "lastRunAt",
      "nextRunAt",
      "consecutiveFailures",
    ]);
    for (const key of Object.keys(report!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SENSITIVE_MESSAGE);
    expect(serialized).not.toContain("top secret customer name");
    // errorClass is allowed, but must be the classification, never the message.
    expect(report!.errorClass).toBe("config");
  });

  it("recordRun / pendingReports never leak a message field beyond the RunReport allow-list", () => {
    const outcome = {
      jobId: "job-1",
      startedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      finishedAt: new Date("2026-01-01T00:00:05.000Z").toISOString(),
      status: "failed" as const,
      rowsSent: 0,
      rowsDeleted: 0,
      parts: 0,
      errorClass: "config",
      isRealtime: false,
      // Not part of RecordRunInput's declared type — simulates a caller
      // accidentally attaching extra context (e.g. a raw row or server
      // message); recordRun must not thread it through regardless.
      message: SENSITIVE_MESSAGE,
      rawRow: { customerName: "top secret customer name" },
    };

    recordRun(dir, outcome as never);
    const [report] = pendingReports(dir);
    expect(report).toBeDefined();

    const allowedKeys = new Set([
      "runId",
      "jobId",
      "mode",
      "startedAt",
      "finishedAt",
      "status",
      "rowsSent",
      "rowsDeleted",
      "parts",
      "errorClass",
      "isRealtimeAggregate",
      "periodStart",
      "periodEnd",
    ]);
    for (const key of Object.keys(report!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SENSITIVE_MESSAGE);
    expect(serialized).not.toContain("top secret customer name");
  });
});
