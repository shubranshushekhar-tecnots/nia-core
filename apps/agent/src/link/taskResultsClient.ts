import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";

export interface TaskResultInput {
  taskId: string;
  status: "done" | "failed";
  result?: unknown;
  errorClass?: string;
}

export interface TaskResultsClientOptions {
  platformUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — same knob as HttpAgentTransport/planometry/client.ts. */
  caBundlePem?: string;
  /** Per-request ceiling. Defaults to 10s — this is a best-effort fire-and-forget post, not something callers block a task's own deadline on. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Slice C1 — posts a finished task's result to the bridge the moment it
 * finishes (not queued for the next check-in — plan §3's "POSTed
 * immediately"), mirroring HttpAgentTransport's proxy/dispatcher pattern
 * exactly. Best-effort: a failure here is swallowed, never thrown back
 * into TaskRunner's flow — the bridge's own per-task timeout (8s/10s)
 * already covers the case where no result ever arrives, resolving to
 * "agent did not respond in time" on the caller's side.
 */
export class TaskResultsClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly options: TaskResultsClientOptions) {
    this.url = `${options.platformUrl.replace(/\/$/, "")}/agent-api/task-results`;
    const proxyUrl = resolveProxyUrl(this.url);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async post(input: TaskResultInput): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await request(this.url, {
        method: "POST",
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.agentKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    } catch {
      // Best-effort — see class doc comment.
    } finally {
      clearTimeout(timer);
    }
  }
}
