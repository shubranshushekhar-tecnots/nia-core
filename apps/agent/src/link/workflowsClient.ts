import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import { LinkRevokedError, LinkTransientError } from "./transport.js";

/**
 * Agent app "Workflows" screen — the agent's client for the bridge's
 * four workflow routes (services/agent-bridge/src/app.ts): list this
 * agent's platform-published workflows, fetch one's run history, fetch
 * one's sanitized read-only graph, and request an action (run now /
 * pause / resume) on one.
 *
 * Response shapes below are plain TS interfaces mirroring the bridge's
 * routes exactly, not an @nia/schemas import — same convention as
 * setupClient.ts's PublishedJobSetup/FetchedSetup (apps/agent has no
 * dependency on that package).
 *
 * Like SetupClient (and unlike TaskResultsClient's best-effort
 * fire-and-forget posture), every method here throws rather than
 * swallows — the local API routes (localApi/routes/workflows.ts) are
 * responsible for catching LinkTransientError/LinkRevokedError and
 * falling back to cached/offline data; this client's job is only to
 * talk to the bridge and report exactly what happened.
 */

export type WorkflowStatus = "ok" | "failing" | "paused" | "rejected" | "waiting";

export interface WorkflowLastRun {
  status: "ok" | "failed";
  finishedAt: string;
  rowsSent: number;
  errorClass: string | null;
}

/** GET /agent-api/workflows's per-row shape exactly (app.ts). */
export interface WorkflowSummary {
  workflowId: string;
  setupId: string;
  name: string;
  status: WorkflowStatus;
  errorClass: string | null;
  rejectionReason: string | null;
  nextRunAt: string | null;
  lastRun: WorkflowLastRun | null;
}

/** GET /agent-api/workflows/:workflowId/runs's per-row shape exactly (app.ts). */
export interface WorkflowRun {
  id: string;
  runId: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  mode: string | null;
  durationMs: number;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
}

export type SanitizedGraphNodeType = "source" | "transform" | "destination";

/** GET /agent-api/workflows/:workflowId/graph's per-node shape exactly (app.ts's SanitizedGraphNode / mapGraphNodeForAgent). Never config/vault_secret_ref. */
export interface SanitizedGraphNode {
  id: string;
  type: SanitizedGraphNodeType;
  position: { x: number; y: number };
  manifestName: string | null;
  connectionLabel: string | null;
  region: string | null;
  entityLabel: string | null;
  writeModeLabel: string | null;
  resolved: boolean;
  unknownReason: string | null;
}

export interface SanitizedGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface SanitizedGraph {
  workflowId: string;
  version: number;
  nodes: SanitizedGraphNode[];
  edges: SanitizedGraphEdge[];
}

/**
 * Deliberately narrower than apps/api's AgentSetupActionRequest —
 * `allowMassDelete` has no field here at all, matching the bridge's
 * `.strict()` WorkflowActionBody: it is structurally impossible for
 * this client to send that key.
 */
export interface WorkflowActionBody {
  kind: "run_now" | "pause" | "resume";
  params?: Record<string, string>;
  fullReload?: boolean;
}

/** The bridge's combined 404 for "doesn't exist, isn't yours, or was unpublished" — never distinguishable from outside, same posture as SetupNotFoundError. */
export class WorkflowNotFoundError extends Error {
  constructor() {
    super("workflow not found");
    this.name = "WorkflowNotFoundError";
  }
}

/** The bridge's 403 when a `resume` would lift a mass-delete pause — the agent app must surface this distinctly rather than as a generic failure, since the fix (review on the website) is specific. */
export class MassDeleteGuardError extends Error {
  constructor() {
    super("paused by the mass-delete guard — review and resume from the website");
    this.name = "MassDeleteGuardError";
  }
}

export interface WorkflowsClientOptions {
  platformUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — same knob as HttpAgentTransport/SetupClient. */
  caBundlePem?: string;
  /** Per-request ceiling. Defaults to 10s — these are plain request/response calls, not long-polls. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class WorkflowsClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: WorkflowsClientOptions) {
    this.baseUrl = options.platformUrl.replace(/\/$/, "");
    const proxyUrl = resolveProxyUrl(this.baseUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async listWorkflows(signal?: AbortSignal): Promise<WorkflowSummary[]> {
    const res = (await this.call("GET", "/agent-api/workflows", undefined, signal)) as { workflows: WorkflowSummary[] };
    return res.workflows;
  }

  async listRuns(workflowId: string, limit = 20, signal?: AbortSignal): Promise<WorkflowRun[]> {
    const res = (await this.call(
      "GET",
      `/agent-api/workflows/${workflowId}/runs?limit=${limit}`,
      undefined,
      signal,
    )) as { runs: WorkflowRun[] };
    return res.runs;
  }

  async getGraph(workflowId: string, signal?: AbortSignal): Promise<SanitizedGraph> {
    return (await this.call("GET", `/agent-api/workflows/${workflowId}/graph`, undefined, signal)) as SanitizedGraph;
  }

  async postAction(workflowId: string, body: WorkflowActionBody, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/agent-api/workflows/${workflowId}/actions`, body, signal);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(`${this.baseUrl}${path}`, {
        method,
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.agentKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new LinkTransientError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const text = await res.body.text();

    if (res.statusCode === 401) throw new LinkRevokedError();
    if (res.statusCode === 403) throw new MassDeleteGuardError();
    if (res.statusCode === 404) throw new WorkflowNotFoundError();
    if (res.statusCode >= 300) throw new LinkTransientError(`platform returned ${res.statusCode}`);

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new LinkTransientError("platform returned a non-JSON response");
    }
  }
}
