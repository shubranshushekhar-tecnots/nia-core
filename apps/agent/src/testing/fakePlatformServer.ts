import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { AgentConnectionReport, AgentTask, CheckInRequest, CheckInResponse, CheckInSetupSummary } from "../link/transport.js";
import type { PublishedJobSetup } from "../link/setupClient.js";

/**
 * A local stand-in for the platform's agent-facing endpoints
 * (services/agent-bridge/src/app.ts's `/agent-api/*` routes), for use in
 * CI (the windows-installer workflow) and in fast local integration
 * tests, without a real Postgres-backed bridge.
 *
 * Built directly from the bridge's own request/response shapes so it
 * cannot silently drift: the wire types below are imported, not
 * retyped, from apps/agent's own `link/transport.ts` and
 * `link/setupClient.ts` — which are themselves documented as mirroring
 * the bridge's zod schemas exactly. Response bodies for `/pair`,
 * `/check-in`, `/setups/:id`, `/setups/:id/secret`, and
 * `/setups/:id/report` match services/agent-bridge/src/app.ts's
 * handlers field-for-field.
 *
 * Deliberately out of scope (not exercised by any Windows-installer
 * check A-I, and not part of "pair, check-in, task results, setups"):
 * the read-ahead batch-read protocol (`read_batch` tasks and
 * `/agent-api/read-batches/:taskId`). `read_batch` tasks can still be
 * queued and delivered on check-in like any other task kind; this fake
 * just never expects an agent to act on one.
 *
 * Driven from outside the Node process (e.g. a PowerShell test script
 * driving a real installed agent) via a parallel `/control/*` surface
 * on the same server — see the methods below for the in-process
 * equivalents a Node-level integration test would call directly
 * instead.
 */

interface PairingCode {
  code: string;
  consumed: boolean;
}

interface FakeSetup {
  id: string;
  workflowId: string;
  wantedVersion: number;
  appliedVersion: number;
  removed: boolean;
  rejectionReason: string | null;
  setup: PublishedJobSetup | null;
  localSourceConnectionId: string | null;
  destination: { connectorId: string; config: Record<string, unknown> };
  secret: Record<string, unknown>;
}

interface PendingTaskResult {
  status: "done" | "failed";
  result?: unknown;
  errorClass?: string;
}

/**
 * Mirrors the bridge's real `GET /agent-api/update` response shape
 * (services/agent-bridge/src/app.ts) minus the `os`-specific file lookup —
 * a test driver sets exactly one update directly via `/control/update`
 * (or `registerUpdate()` in-process), so there's no per-OS manifest to
 * pick from here.
 */
interface FakeUpdateInfo {
  latestVersion: string;
  /** Absolute path to the file this fake serves back from `/control/update-file` — never uploaded into the fake server, just read off disk on each download request. */
  filePath: string;
  sha256: string;
  minVersion: string;
}

interface FakeAgent {
  id: string;
  agentKey: string;
  agentVersion: string | null;
  hostName: string | null;
  revoked: boolean;
  reportedConnections: AgentConnectionReport[];
  reportedLocalJobs: unknown[];
  acknowledgedRunIds: string[];
  pendingTasks: AgentTask[];
  setups: Map<string, FakeSetup>;
  taskResults: Map<string, PendingTaskResult>;
  /** Resolved by a waiting check-in as soon as a task/setup is queued for it, so `noHold: false` callers don't have to sit out the full hold. */
  wake?: () => void;
}

export interface FakePlatformServerOptions {
  /** Defaults to 0 (ephemeral). */
  port?: number;
  /** How long a `noHold`-less check-in waits for new work before returning empty. Defaults to 200ms — short, since this is a fake with no real long-poll cost; override for fidelity tests. */
  holdMs?: number;
}

export class FakePlatformServer {
  baseUrl = "";
  private readonly server: Server;
  private readonly pairingCodes = new Map<string, PairingCode>();
  private readonly agentsById = new Map<string, FakeAgent>();
  private readonly agentsByKey = new Map<string, FakeAgent>();
  private readonly holdMs: number;
  /** Set via `/control/update` (or `registerUpdate()`); `undefined` means `/agent-api/update` 404s, same as the real bridge with no manifest built yet. */
  private updateInfo: FakeUpdateInfo | undefined;

  private constructor(server: Server, holdMs: number) {
    this.server = server;
    this.holdMs = holdMs;
  }

  static async start(options: FakePlatformServerOptions = {}): Promise<FakePlatformServer> {
    const server = createServer();
    const instance = new FakePlatformServer(server, options.holdMs ?? 200);
    server.on("request", (req, res) => void instance.handle(req, res));
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    instance.baseUrl = `http://127.0.0.1:${port}`;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- in-process test helpers (same effect as the /control/* routes below) ----

  /** Registers a one-time pairing code. Returns the composite `<pairingCodeId>.<code>` string `nia-agent pair` expects, plus the parts. */
  registerPairingCode(code = randomBytes(4).toString("hex")): { pairingCodeId: string; code: string; composite: string } {
    const pairingCodeId = randomUUID();
    this.pairingCodes.set(pairingCodeId, { code, consumed: false });
    return { pairingCodeId, code, composite: `${pairingCodeId}.${code}` };
  }

  /** Configures what `GET /agent-api/update` (and the real agent's HttpUpdateClient) will see. Pass `undefined` to clear it (404 again). */
  registerUpdate(info: FakeUpdateInfo | undefined): void {
    this.updateInfo = info;
  }

  /** Test introspection: full state for an agent, including what it has reported and every setup's applied/rejected status. */
  getAgent(agentId: string): FakeAgent | undefined {
    return this.agentsById.get(agentId);
  }

  revokeAgent(agentId: string): void {
    const agent = this.agentsById.get(agentId);
    if (agent) agent.revoked = true;
  }

  /** Queues a task for delivery on this agent's next check-in. */
  queueTask(agentId: string, task: AgentTask): void {
    const agent = this.mustGetAgent(agentId);
    agent.pendingTasks.push(task);
    agent.wake?.();
  }

  /** Reads back a task's reported result (posted via /agent-api/task-results), once the agent has posted it. */
  getTaskResult(agentId: string, taskId: string): PendingTaskResult | undefined {
    return this.mustGetAgent(agentId).taskResults.get(taskId);
  }

  /** Publishes (or republishes at a higher version) a platform-managed job setup for delivery on this agent's next check-in. */
  publishSetup(
    agentId: string,
    input: {
      id?: string;
      workflowId: string;
      wantedVersion: number;
      setup: PublishedJobSetup | null;
      localSourceConnectionId: string | null;
      destination: { connectorId: string; config: Record<string, unknown> };
      secret: Record<string, unknown>;
    },
  ): string {
    const agent = this.mustGetAgent(agentId);
    const id = input.id ?? randomUUID();
    const existing = agent.setups.get(id);
    agent.setups.set(id, {
      id,
      workflowId: input.workflowId,
      wantedVersion: input.wantedVersion,
      appliedVersion: existing?.appliedVersion ?? 0,
      removed: false,
      rejectionReason: existing?.rejectionReason ?? null,
      setup: input.setup,
      localSourceConnectionId: input.localSourceConnectionId,
      destination: input.destination,
      secret: input.secret,
    });
    agent.wake?.();
    return id;
  }

  /** Marks a setup removed (unpublished) — delivered as `removed: true` on the next check-in, regardless of version. */
  removeSetup(agentId: string, setupId: string): void {
    const setup = this.mustGetAgent(agentId).setups.get(setupId);
    if (setup) setup.removed = true;
    this.mustGetAgent(agentId).wake?.();
  }

  private mustGetAgent(agentId: string): FakeAgent {
    const agent = this.agentsById.get(agentId);
    if (!agent) throw new Error(`no fake agent with id ${agentId}`);
    return agent;
  }

  // ---- HTTP plumbing ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "POST" && path === "/agent-api/pair") return this.handlePair(req, res);
      if (req.method === "POST" && path === "/agent-api/check-in") return this.handleCheckIn(req, res);
      if (req.method === "POST" && path === "/agent-api/task-results") return this.handleTaskResults(req, res);
      if (req.method === "GET" && path === "/agent-api/update") return this.handleFetchUpdate(req, res);

      let m = /^\/agent-api\/setups\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) return this.handleFetchSetup(req, res, m[1]!);

      m = /^\/agent-api\/setups\/([^/]+)\/secret$/.exec(path);
      if (req.method === "GET" && m) return this.handleFetchSecret(req, res, m[1]!);

      m = /^\/agent-api\/setups\/([^/]+)\/report$/.exec(path);
      if (req.method === "POST" && m) return this.handleReport(req, res, m[1]!);

      // ---- control surface, for an out-of-process driver (e.g. PowerShell) ----

      if (req.method === "POST" && path === "/control/pairing-codes") {
        const body = (await readJsonBody(req)) as { code?: string };
        sendJson(res, 200, this.registerPairingCode(body.code));
        return;
      }

      m = /^\/control\/agents\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const agent = this.agentsById.get(m[1]!);
        if (!agent) return sendJson(res, 404, { message: "no such agent" });
        sendJson(res, 200, {
          id: agent.id,
          agentVersion: agent.agentVersion,
          hostName: agent.hostName,
          revoked: agent.revoked,
          reportedConnections: agent.reportedConnections,
          reportedLocalJobs: agent.reportedLocalJobs,
          setups: [...agent.setups.values()],
        });
        return;
      }

      m = /^\/control\/agents\/([^/]+)\/tasks$/.exec(path);
      if (req.method === "POST" && m) {
        const task = (await readJsonBody(req)) as AgentTask;
        this.queueTask(m[1]!, task);
        sendJson(res, 200, { ok: true });
        return;
      }

      m = /^\/control\/agents\/([^/]+)\/setups$/.exec(path);
      if (req.method === "POST" && m) {
        const body = (await readJsonBody(req)) as Parameters<FakePlatformServer["publishSetup"]>[1];
        const id = this.publishSetup(m[1]!, body);
        sendJson(res, 200, { id });
        return;
      }

      m = /^\/control\/agents\/([^/]+)\/setups\/([^/]+)\/remove$/.exec(path);
      if (req.method === "POST" && m) {
        this.removeSetup(m[1]!, m[2]!);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/control/update") {
        const body = (await readJsonBody(req)) as Partial<FakeUpdateInfo>;
        if (!body.latestVersion || !body.filePath || !body.sha256) {
          sendJson(res, 400, { message: "latestVersion, filePath, and sha256 are required" });
          return;
        }
        this.registerUpdate({ latestVersion: body.latestVersion, filePath: body.filePath, sha256: body.sha256, minVersion: body.minVersion ?? "0.0.0" });
        sendJson(res, 200, { ok: true, downloadUrl: `${this.baseUrl}/control/update-file` });
        return;
      }

      // No Bearer check here, on purpose: the real agent-bridge's download
      // URL (resolved from the manifest, served off S3/a CDN/the dev web
      // app's own allow-listed route) is never itself behind the agent-key
      // auth that only /agent-api/* requires -- HttpUpdateClient.download()
      // (link/updateClient.ts) deliberately sends no Authorization header,
      // so this fake must accept an unauthenticated GET too to be faithful.
      if (req.method === "GET" && path === "/control/update-file") return this.handleDownloadUpdateFile(res);

      sendJson(res, 404, { message: "not found" });
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as { pairingCodeId?: string; code?: string };
    const pairingCodeId = body.pairingCodeId;
    const code = body.code;
    const entry = pairingCodeId ? this.pairingCodes.get(pairingCodeId) : undefined;

    if (!pairingCodeId || !code || !entry) {
      sendJson(res, 401, { message: "pairing code is invalid" });
      return;
    }
    if (entry.consumed) {
      sendJson(res, 401, { message: "pairing code has already been used" });
      return;
    }
    if (entry.code !== code) {
      sendJson(res, 401, { message: "pairing code is invalid" });
      return;
    }
    entry.consumed = true;

    const id = randomUUID();
    const agentKey = randomBytes(24).toString("hex");
    const agent: FakeAgent = {
      id,
      agentKey,
      agentVersion: null,
      hostName: null,
      revoked: false,
      reportedConnections: [],
      reportedLocalJobs: [],
      acknowledgedRunIds: [],
      pendingTasks: [],
      setups: new Map(),
      taskResults: new Map(),
    };
    this.agentsById.set(id, agent);
    this.agentsByKey.set(agentKey, agent);
    sendJson(res, 200, { agentId: id, agentKey });
  }

  private resolveAgent(req: IncomingMessage): FakeAgent | undefined {
    const header = req.headers.authorization ?? "";
    const agentKey = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const agent = agentKey ? this.agentsByKey.get(agentKey) : undefined;
    return agent && !agent.revoked ? agent : undefined;
  }

  private async handleCheckIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "agent key is invalid or revoked" });
      return;
    }
    const body = (await readJsonBody(req)) as CheckInRequest;
    agent.agentVersion = body.agentVersion ?? agent.agentVersion;
    agent.hostName = body.hostName ?? agent.hostName;
    if (body.agentConnections !== undefined) agent.reportedConnections = body.agentConnections;
    if (body.localJobs !== undefined) agent.reportedLocalJobs = body.localJobs;
    const acknowledgedRunIds = (body.runReports ?? []).map((r) => r.runId);

    if (!body.noHold && agent.pendingTasks.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.holdMs);
        agent.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      agent.wake = undefined;
    }

    const tasks = agent.pendingTasks.splice(0, agent.pendingTasks.length);
    const setups: CheckInSetupSummary[] = [...agent.setups.values()].map((s) => ({
      id: s.id,
      workflowId: s.workflowId,
      wantedVersion: s.wantedVersion,
      appliedVersion: s.appliedVersion,
      removed: s.removed,
    }));

    const response: CheckInResponse = { tasks, acknowledgedRunIds, setups };
    sendJson(res, 200, response);
  }

  private async handleTaskResults(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "missing agent key" });
      return;
    }
    const body = (await readJsonBody(req)) as { taskId: string; status: "done" | "failed"; result?: unknown; errorClass?: string };
    agent.taskResults.set(body.taskId, { status: body.status, result: body.result, errorClass: body.errorClass });
    sendJson(res, 200, { ok: true });
  }

  private async handleFetchUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "agent key is invalid or revoked" });
      return;
    }
    if (!this.updateInfo) {
      sendJson(res, 404, { message: "no update configured" });
      return;
    }
    sendJson(res, 200, {
      latestVersion: this.updateInfo.latestVersion,
      url: `${this.baseUrl}/control/update-file`,
      sha256: this.updateInfo.sha256,
      minVersion: this.updateInfo.minVersion,
    });
  }

  private async handleDownloadUpdateFile(res: ServerResponse): Promise<void> {
    if (!this.updateInfo) {
      sendJson(res, 404, { message: "no update configured" });
      return;
    }
    const { filePath } = this.updateInfo;
    try {
      const stats = await stat(filePath);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stats.size });
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on("error", reject);
        res.on("error", reject);
        res.on("finish", resolve);
        stream.pipe(res);
      });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 404, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleFetchSetup(req: IncomingMessage, res: ServerResponse, setupId: string): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "agent key is invalid or revoked" });
      return;
    }
    const setup = agent.setups.get(setupId);
    if (!setup) {
      sendJson(res, 404, { message: "setup not found" });
      return;
    }
    sendJson(res, 200, {
      id: setup.id,
      workflowId: setup.workflowId,
      wantedVersion: setup.wantedVersion,
      setup: setup.setup,
      localSourceConnectionId: setup.localSourceConnectionId,
      destination: setup.destination,
    });
  }

  private async handleFetchSecret(req: IncomingMessage, res: ServerResponse, setupId: string): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "agent key is invalid or revoked" });
      return;
    }
    const setup = agent.setups.get(setupId);
    if (!setup) {
      sendJson(res, 404, { message: "setup not found" });
      return;
    }
    sendJson(res, 200, setup.secret);
  }

  private async handleReport(req: IncomingMessage, res: ServerResponse, setupId: string): Promise<void> {
    const agent = this.resolveAgent(req);
    if (!agent) {
      sendJson(res, 401, { message: "agent key is invalid or revoked" });
      return;
    }
    const setup = agent.setups.get(setupId);
    if (!setup) {
      sendJson(res, 404, { message: "setup not found" });
      return;
    }
    const body = (await readJsonBody(req)) as { appliedVersion?: number; rejectionReason?: string };
    // Mirrors the bridge's own rule exactly (app.ts's /report handler):
    // applying coalesces appliedVersion and always clears rejectionReason
    // unless a rejectionReason is given in this same call; rejecting
    // leaves appliedVersion untouched.
    if (body.appliedVersion !== undefined) setup.appliedVersion = body.appliedVersion;
    setup.rejectionReason = body.rejectionReason ?? null;
    sendJson(res, 200, { ok: true });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
