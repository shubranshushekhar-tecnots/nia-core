import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import { LinkRevokedError, LinkTransientError } from "./transport.js";

/**
 * Slice R3a (docs/plans/agent-canvas-integration.md B.4/B.7) — the
 * agent's client for the bridge's three setup routes
 * (services/agent-bridge/src/app.ts): fetch one published setup (no
 * secrets), fetch that setup's destination secret separately, and
 * report it applied at a version or rejected with a reason.
 *
 * `PublishedJobSetup`/`FetchedSetup` below mirror packages/schemas/src/
 * agentJobSetup.ts's `AgentJobSetup` and the bridge's own GET
 * /agent-api/setups/:id response shape exactly, as plain TS interfaces
 * rather than an @nia/schemas import — apps/agent has no dependency on
 * that package, same convention as this directory's other client files
 * (transport.ts's AgentConnectionReport/AgentTask, localJobReports.ts's
 * LocalJobReport).
 *
 * Unlike TaskResultsClient (best-effort, fire-and-forget), every method
 * here throws rather than swallows: a caller needs the real setup/
 * secret to apply it, and needs to know whether a report actually
 * landed.
 */

export interface SetupMappingColumn {
  source: string;
  target: string;
}

export interface SetupColumn {
  name: string;
  type: string;
  isKey: boolean;
}

export type SetupMode = "replace" | "upsertDelta" | "realtime";
export type SetupDeleteMode = "none" | "reconciliation" | "softDelete";

/** A FilterCondition entry (packages/schemas/src/nodeConfig.ts) — flat AND-chain, reused as-is. */
export interface SetupFilterCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_null" | "is_not_null";
  value?: string | number | boolean;
  caseInsensitive?: boolean;
}

/** Mirrors AgentJobSetup exactly (packages/schemas/src/agentJobSetup.ts) — no secrets. */
export interface PublishedJobSetup {
  sourceConnectionId: string;
  sourceTable: string;
  destinationConnectionId: string;
  columns: SetupColumn[];
  mapping: SetupMappingColumn[];
  filter: SetupFilterCondition[];
  params: Record<string, string>;
  mode: SetupMode;
  watermarkColumn?: string;
  overlapSeconds?: number;
  schedule?: string;
  replaceSchedule?: string;
  pollIntervalSeconds?: number;
  reconciliationIntervalSeconds?: number;
  deleteMode?: SetupDeleteMode;
  maxDeletePercent?: number;
  softDeleteColumn?: string;
}

/** GET /agent-api/setups/:id's response shape exactly (app.ts). */
export interface FetchedSetup {
  id: string;
  workflowId: string;
  wantedVersion: number;
  setup: PublishedJobSetup | null;
  /** The platform's own source connection resolved to this agent's local connection id — never the platform's connections.id. */
  localSourceConnectionId: string | null;
  destination: { connectorId: string; config: Record<string, unknown> };
}

/** The bridge's combined 404 for "doesn't exist, isn't yours, or was unpublished" — never distinguishable from outside (app.ts's own doc comment). */
export class SetupNotFoundError extends Error {
  constructor() {
    super("setup not found");
    this.name = "SetupNotFoundError";
  }
}

export interface SetupClientOptions {
  platformUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — same knob as HttpAgentTransport/TaskResultsClient. */
  caBundlePem?: string;
  /** Per-request ceiling. Defaults to 10s — these are plain request/response calls, not long-polls. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class SetupClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: SetupClientOptions) {
    this.baseUrl = options.platformUrl.replace(/\/$/, "");
    const proxyUrl = resolveProxyUrl(this.baseUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async fetchSetup(setupId: string, signal?: AbortSignal): Promise<FetchedSetup> {
    return (await this.call("GET", `/agent-api/setups/${setupId}`, undefined, signal)) as FetchedSetup;
  }

  /** The destination connection's decrypted secret fields — never log the result; callers must not either. */
  async fetchSecret(setupId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.call("GET", `/agent-api/setups/${setupId}/secret`, undefined, signal)) as Record<
      string,
      unknown
    >;
  }

  /** Clears any previous rejection on the bridge side — mirrors SetupReportBody's "applying clears a rejection" rule. */
  async reportApplied(setupId: string, appliedVersion: number, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/agent-api/setups/${setupId}/report`, { appliedVersion }, signal);
  }

  /** Leaves appliedVersion untouched on the bridge side — mirrors SetupReportBody's "rejecting leaves applied_version untouched" rule. */
  async reportRejected(setupId: string, rejectionReason: string, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/agent-api/setups/${setupId}/report`, { rejectionReason }, signal);
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
    if (res.statusCode === 404) throw new SetupNotFoundError();
    if (res.statusCode >= 300) throw new LinkTransientError(`platform returned ${res.statusCode}`);

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new LinkTransientError("platform returned a non-JSON response");
    }
  }
}
