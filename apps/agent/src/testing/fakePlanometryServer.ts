import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CHUNK_ROWS_HEADER, CHUNK_SEQ_HEADER } from "../planometry/types.js";
import type { CatalogPushRequest, CompleteRunRequest, FailedRunRequest, WorkItem } from "../planometry/types.js";

/**
 * Fake Planometry push server for tests (docs/plans/planometry-integration.md
 * Phase 2 §8) — a real `node:http` server on an ephemeral port, same pattern
 * as apps/api's route tests (`listen(0, "127.0.0.1")`), not a mock of
 * `fetch`. Implements catalog/work/chunk/complete/failed + heartbeat, plus
 * fault injection (dropped chunk, forced 409) scoped per run so individual
 * tests can target exactly the chunk seq they want to exercise.
 */

export interface RunFaultConfig {
  /** Chunk seqs whose first delivery attempt is dropped (socket destroyed, no response) — forces the client to retry with the same seq. */
  dropOnFirstAttempt?: Set<number>;
  /** Chunk seqs that always get a 409 response, simulating Planometry superseding/aborting the run. */
  force409?: Set<number>;
}

interface RunRecord {
  connectionId: string;
  /** seq -> rows in that chunk, keyed so a duplicate delivery of the same seq is a no-op re-ack, never double-counted. */
  chunks: Map<number, number>;
  attemptedSeqs: Set<number>;
  heartbeatCount: number;
  complete?: CompleteRunRequest;
  failed?: FailedRunRequest;
}

export class FakePlanometryServer {
  baseUrl = "";
  private readonly server: Server;
  private readonly workQueues = new Map<string, WorkItem[]>();
  private readonly catalogPushes = new Map<string, CatalogPushRequest>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly runFaults = new Map<string, RunFaultConfig>();
  private pollAfterSeconds = 1;
  /** Unset by default (no auth enforced, matching every existing test's behavior). Set via `requireAgentKey()` to make the server reject requests whose `Authorization` header doesn't match, for doctor's "agent key accepted" check. */
  private requiredAgentKey?: string;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakePlanometryServer> {
    const server = createServer();
    const instance = new FakePlanometryServer(server);
    server.on("request", (req, res) => instance.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    instance.baseUrl = `http://127.0.0.1:${port}`;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  enqueueWork(connectionId: string, work: WorkItem): void {
    const queue = this.workQueues.get(connectionId) ?? [];
    queue.push(work);
    this.workQueues.set(connectionId, queue);
  }

  setPollAfterSeconds(seconds: number): void {
    this.pollAfterSeconds = seconds;
  }

  /** Opt-in: once set, every request must carry `Authorization: Bearer <key>` or gets a 401 — used by doctor's "agent key accepted" integration test. */
  requireAgentKey(key: string): void {
    this.requiredAgentKey = key;
  }

  setRunFaults(runId: string, faults: RunFaultConfig): void {
    this.runFaults.set(runId, faults);
  }

  getCatalogPush(connectionId: string): CatalogPushRequest | undefined {
    return this.catalogPushes.get(connectionId);
  }

  getRun(runId: string): { heartbeatCount: number; totalRows: number; chunkCount: number; complete?: CompleteRunRequest; failed?: FailedRunRequest } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      heartbeatCount: run.heartbeatCount,
      totalRows: [...run.chunks.values()].reduce((sum, rows) => sum + rows, 0),
      chunkCount: run.chunks.size,
      complete: run.complete,
      failed: run.failed,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.requiredAgentKey !== undefined && req.headers.authorization !== `Bearer ${this.requiredAgentKey}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const chunkMatch = /^\/v1\/runs\/([^/]+)\/chunks$/.exec(url.pathname);
    const heartbeatMatch = /^\/v1\/runs\/([^/]+)\/heartbeat$/.exec(url.pathname);
    const completeMatch = /^\/v1\/runs\/([^/]+)\/complete$/.exec(url.pathname);
    const failedMatch = /^\/v1\/runs\/([^/]+)\/failed$/.exec(url.pathname);

    try {
      if (req.method === "POST" && url.pathname === "/v1/catalog") {
        const body = await readJsonBody<CatalogPushRequest>(req);
        this.catalogPushes.set(body.connectionId, body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/work") {
        const connectionId = url.searchParams.get("connectionId") ?? "";
        const queue = this.workQueues.get(connectionId) ?? [];
        const work = queue.shift() ?? null;
        if (work) this.runs.set(work.runId, this.runs.get(work.runId) ?? newRunRecord(connectionId));
        sendJson(res, 200, { work, pollAfterSeconds: this.pollAfterSeconds });
        return;
      }

      if (req.method === "POST" && chunkMatch?.[1]) {
        await this.handleChunk(req, res, chunkMatch[1]);
        return;
      }

      if (req.method === "POST" && heartbeatMatch?.[1]) {
        const run = this.runs.get(heartbeatMatch[1]);
        if (run) run.heartbeatCount += 1;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && completeMatch?.[1]) {
        const body = await readJsonBody<CompleteRunRequest>(req);
        const run = this.runs.get(completeMatch[1]);
        if (run) run.complete = body;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && failedMatch?.[1]) {
        const body = await readJsonBody<FailedRunRequest>(req);
        const run = this.runs.get(failedMatch[1]);
        if (run) run.failed = body;
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleChunk(req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
    const seqHeader = req.headers[CHUNK_SEQ_HEADER];
    const rowsHeader = req.headers[CHUNK_ROWS_HEADER];
    const seq = Number(Array.isArray(seqHeader) ? seqHeader[0] : seqHeader);
    const rows = Number(Array.isArray(rowsHeader) ? rowsHeader[0] : rowsHeader);
    await drainRequest(req);

    const faults = this.runFaults.get(runId);
    const run = this.runs.get(runId) ?? newRunRecord("");
    this.runs.set(runId, run);

    if (faults?.force409?.has(seq)) {
      sendJson(res, 409, { error: "run superseded" });
      return;
    }

    if (faults?.dropOnFirstAttempt?.has(seq) && !run.attemptedSeqs.has(seq)) {
      run.attemptedSeqs.add(seq);
      req.socket.destroy();
      return;
    }
    run.attemptedSeqs.add(seq);

    // Idempotent per (run, seq): a retried or duplicated delivery of a seq
    // already recorded is re-acked without changing the recorded row count.
    if (!run.chunks.has(seq)) run.chunks.set(seq, rows);
    sendJson(res, 200, { ok: true });
  }
}

function newRunRecord(connectionId: string): RunRecord {
  return { connectionId, chunks: new Map(), attemptedSeqs: new Set(), heartbeatCount: 0 };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function drainRequest(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) {
    // chunk upload bodies are opaque gzipped bytes — row counts travel in
    // the X-Chunk-Rows header (see planometry/types.ts), so the body only
    // needs to be fully drained here, not parsed.
  }
}
