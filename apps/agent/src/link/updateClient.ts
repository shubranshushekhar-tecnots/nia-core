import { createWriteStream } from "node:fs";
import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import type { UpdateClient, UpdateInfo } from "./updateChecker.js";

export type AgentOs = "windows" | "macos" | "linux";

export interface HttpUpdateClientOptions {
  platformUrl: string;
  agentKey: string;
  os: AgentOs;
  /** PEM contents for a custom CA bundle — same knob as HttpAgentTransport/TaskResultsClient/planometry/client.ts. */
  caBundlePem?: string;
  /** Per-request ceiling for the `GET /agent-api/update` metadata call. Defaults to 30s. */
  timeoutMs?: number;
  /** Separate, much longer ceiling for the installer download itself. Defaults to 10 minutes. */
  downloadTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Phase 6 polish — the agent-side half of `GET /agent-api/update`
 * (services/agent-bridge/src/app.ts), mirroring HttpAgentTransport's/
 * TaskResultsClient's proxy-dispatcher-and-Bearer-auth pattern exactly.
 * `fetchUpdate` is best-effort (never throws — a failed check is just
 * "nothing to do" to UpdateChecker, same as an absent manifest); the
 * larger `download` throws on failure, since UpdateChecker needs to
 * distinguish "download failed" from "checksum mismatch".
 */
export class HttpUpdateClient implements UpdateClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly updateUrl: string;

  constructor(private readonly options: HttpUpdateClientOptions) {
    this.updateUrl = `${options.platformUrl.replace(/\/$/, "")}/agent-api/update`;
    const proxyUrl = resolveProxyUrl(this.updateUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async fetchUpdate(agentVersion: string): Promise<UpdateInfo | undefined> {
    const url = `${this.updateUrl}?os=${encodeURIComponent(this.options.os)}&version=${encodeURIComponent(agentVersion)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await request(url, {
        method: "GET",
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.options.agentKey}` },
      });
      const text = await res.body.text();
      if (res.statusCode !== 200) return undefined;
      return JSON.parse(text) as UpdateInfo;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async download(url: string, destPath: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const res = await request(url, { method: "GET", dispatcher: this.dispatcher, signal: controller.signal });
      if (res.statusCode !== 200) {
        await res.body.text().catch(() => undefined);
        throw new Error(`download failed with status ${res.statusCode}`);
      }
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(destPath);
        res.body.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        res.body.pipe(out);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
