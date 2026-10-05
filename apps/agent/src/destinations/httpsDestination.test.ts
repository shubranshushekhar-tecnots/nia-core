import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncJobEntry } from "../config/types.js";
import { isJobPaused } from "../ops/state.js";
import type { Logger } from "../ops/logger.js";
import type { RunSyncOptions } from "../sync/runSync.js";
import { HttpsDestination } from "./httpsDestination.js";

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

function rowsSource(rows: Record<string, unknown>[]): RunSyncOptions["readSourceRows"] {
  return async (onRow, signal) => {
    for (const row of rows) {
      if (signal.aborted) return;
      onRow(row);
    }
  };
}

function baseJob(targetUrl: string, overrides: Partial<SyncJobEntry> = {}): SyncJobEntry {
  return {
    id: "job-1",
    name: "test https job",
    connectionId: "conn-1",
    sourceTable: "dbo.source",
    targetUrl,
    pushKeyRef: undefined,
    destinationType: "https",
    https: { authMethod: "bearer" },
    strategy: "replace",
    mapping: [
      { source: "id", target: "id" },
      { source: "qty", target: "qty" },
    ],
    targetSchemaSnapshot: { columns: [], keyColumns: [] },
    onNullKey: "stop",
    allowEmptyReplace: false,
    filter: [],
    params: {},
    ...overrides,
  };
}

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Stub HTTP server, in-test only (no containers) — queues a scripted response-status per request so a test can make the Nth request to a job fail then succeed. */
function startStubServer(statuses: number[]): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  let callCount = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ headers: req.headers, body });
        const status = statuses[Math.min(callCount, statuses.length - 1)];
        callCount += 1;
        res.writeHead(status, { "content-type": "application/json" }).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/ingest`, requests });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("HttpsDestination", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-https-dest-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("allowed: sends rows with the sign-in header, batch id and run number, and a resend after a lost response reuses the same batch id", async () => {
    // First attempt simulates a lost response (500 — retried in place by
    // httpsSender.ts); second attempt (the "resend") succeeds.
    const { server, url, requests } = await startStubServer([500, 200]);
    try {
      const destination = new HttpsDestination({
        address: url,
        auth: { method: "bearer", secret: "s3cr3t-token" },
      });

      const result = await destination.run({
        job: baseJob(url),
        sourceColumnTypes: { id: "number", qty: "number" },
        dir,
        masterKey: Buffer.alloc(32),
        logger: silentLogger(),
        readSourceRows: rowsSource([
          { id: 1, qty: 10 },
          { id: 2, qty: 20 },
        ]),
      });

      expect(result.outcome).toBe("completed");
      if (result.outcome === "completed") expect(result.rowsSent).toBe(2);

      expect(requests).toHaveLength(2);
      const [first, second] = requests;
      expect(first.headers.authorization).toBe("Bearer s3cr3t-token");
      expect(first.headers["x-nia-run-number"]).toBe("1");
      expect(first.headers["x-nia-batch-number"]).toBe("1");
      expect(first.headers["x-nia-last-batch"]).toBe("true");
      expect(first.headers["x-nia-batch-id"]).toBeTruthy();
      // The resend after the lost (500) response carries the same batch id.
      expect(second.headers["x-nia-batch-id"]).toBe(first.headers["x-nia-batch-id"]);
      expect(JSON.parse(first.body)).toEqual([
        { id: 1, qty: 10 },
        { id: 2, qty: 20 },
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("refused: a 400 stops the run and pauses the job with no retry", async () => {
    const { server, url, requests } = await startStubServer([400]);
    try {
      const destination = new HttpsDestination({
        address: url,
        auth: { method: "none" },
      });
      const job = baseJob(url, { https: { authMethod: "none" } });

      const result = await destination.run({
        job,
        sourceColumnTypes: { id: "number", qty: "number" },
        dir,
        masterKey: Buffer.alloc(32),
        logger: silentLogger(),
        readSourceRows: rowsSource([{ id: 1, qty: 10 }]),
      });

      expect(result.outcome).toBe("failed");
      // No retry: exactly one request reached the destination.
      expect(requests).toHaveLength(1);
      expect(isJobPaused(job.id, dir)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});
