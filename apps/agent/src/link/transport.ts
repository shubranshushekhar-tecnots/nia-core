import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import type { LocalJobReport } from "./localJobReports.js";
import type { RunReport } from "./runReportOutbox.js";

/**
 * Slice C1 — the agent's self-reported local connections, used by the
 * platform's `sqlserver_agent` connection picker. Only name/database/
 * dialect travel to the platform — never host/user/password. Matches
 * the bridge's `AgentConnectionEntry` zod schema (services/agent-bridge/
 * src/app.ts) exactly.
 */
export interface AgentConnectionReport {
  id: string;
  name: string;
  database: string;
  dialect: string;
}

/**
 * Slice C1 — one task delivered by the bridge in a check-in response,
 * flattened from its internal `AgentTask` shape (services/agent-bridge/
 * src/app.ts's check-in handler: `{id, kind, localConnectionId}`).
 */
export interface AgentTask {
  id: string;
  kind: "test_connection" | "list_tables";
  localConnectionId: string;
}

/**
 * Slice L2 (docs/plans/agent-canvas-integration.md B.3): "Isolated behind
 * an AgentTransport interface on both ends so long-polling can be
 * swapped later." This is the agent-side half — CheckInLoop depends only
 * on this interface, never on undici/HTTP directly, so a future
 * transport (e.g. WebSocket) can replace HttpAgentTransport without
 * touching the loop.
 */
export interface CheckInRequest {
  agentVersion: string;
  hostName: string;
  /** True only on the first check-in after `start` (CheckInLoop) — asks the bridge to skip its usual hold so the link is confirmed (or refused as revoked) within a second or two. */
  noHold?: boolean;
  /** Slice L4 (B.11) — every locally-defined job's current summary. Omitted entirely (not an empty array) means "this agent build doesn't report jobs" — the bridge must never treat an absent key as "zero jobs". */
  localJobs?: LocalJobReport[];
  /** Slice L4 (B.7) — every un-acknowledged run report in the agent's outbox. */
  runReports?: RunReport[];
  /** Slice C1 — every locally-defined connection's current non-secret summary. Same absent-vs-empty-array discipline as `localJobs`. */
  agentConnections?: AgentConnectionReport[];
}

export interface CheckInResponse {
  tasks: AgentTask[];
  /** Slice L4 (B.7) — run ids the bridge has durably stored; the agent removes them from its outbox. */
  acknowledgedRunIds?: string[];
}

export interface AgentTransport {
  checkIn(request: CheckInRequest, signal?: AbortSignal): Promise<CheckInResponse>;
}

/** 401 (B.12: "every subsequent check-in is rejected immediately"). Not retryable — CheckInLoop stops the link permanently on this. */
export class LinkRevokedError extends Error {
  constructor() {
    super("agent key is invalid or revoked");
    this.name = "LinkRevokedError";
  }
}

/** Network failure, timeout, or any other non-2xx — retryable with backoff by CheckInLoop. */
export class LinkTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkTransientError";
  }
}

export interface HttpAgentTransportOptions {
  platformUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — TLS-inspecting corporate proxies, same knob as planometry/client.ts. */
  caBundlePem?: string;
  /** Per-request ceiling against a hung connection. Defaults to 30s — well under the bridge's own ~25s long-poll hold plus network slack. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * POSTs to `${platformUrl}/agent-api/check-in` (B.3) with the agent key
 * as a Bearer token — reuses the same proxy-resolution/undici dispatcher
 * pattern as planometry/client.ts ("the existing proxy settings are
 * used"). Certificates are verified by undici's defaults; `caBundlePem`
 * is the only escape hatch, same as the Planometry client.
 */
export class HttpAgentTransport implements AgentTransport {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly options: HttpAgentTransportOptions) {
    this.url = `${options.platformUrl.replace(/\/$/, "")}/agent-api/check-in`;
    const proxyUrl = resolveProxyUrl(this.url);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async checkIn(body: CheckInRequest, signal?: AbortSignal): Promise<CheckInResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(this.url, {
        method: "POST",
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.agentKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LinkTransientError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const text = await res.body.text();

    if (res.statusCode === 401) throw new LinkRevokedError();
    if (res.statusCode >= 300) throw new LinkTransientError(`platform returned ${res.statusCode}`);

    try {
      return text ? (JSON.parse(text) as CheckInResponse) : { tasks: [] };
    } catch {
      throw new LinkTransientError("platform returned a non-JSON response");
    }
  }
}
