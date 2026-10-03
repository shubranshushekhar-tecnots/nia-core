import { gzipSync } from "node:zlib";
import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "./network.js";
import type { ConnectionCheckResult, PushRequestBody, PushResult, ResponseEnvelope, TableSchema } from "./types.js";

/** No stated server-side limit (docs/planometry/connector-guide-v4.md §7 covers payload size, not latency) — this is purely the agent's own ceiling against a hung connection. */
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface PlanometryClientOptions {
  /** The table's push URL (guide §1), e.g. `https://app.planometry.com/api/push/<tableId>`. */
  tableUrl: string;
  pushKey: string;
  /** PEM contents for a custom CA bundle — TLS-inspecting corporate proxies. */
  caBundlePem?: string;
  /** Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** 401/404 (guide §6b): wrong/regenerated key, a key belonging to another table, or a deleted table. Not retryable — needs reconfiguration. */
export class PlanometryConfigError extends Error {
  constructor(public readonly status: 401 | 404) {
    super(
      status === 401
        ? "wrong or regenerated key, or the table was deleted"
        : "the table id in the URL does not match this key",
    );
    this.name = "PlanometryConfigError";
  }
}

/** 400 (guide §2.3/§6b): the server rejected the request body itself — nothing was written. Not retryable as-is. */
export class PlanometryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanometryRejectedError";
  }
}

/** Network failure, timeout, or 5xx — retryable by the caller. */
export class PlanometryTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanometryTransientError";
  }
}

/**
 * Thin, single-attempt v4 wire client — no retries, no logging (callers own
 * both, since only they know which modes are safe to retry). Never embeds
 * `pushKey` in any thrown error.
 */
export class PlanometryClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;

  constructor(private readonly options: PlanometryClientOptions) {
    const proxyUrl = resolveProxyUrl(options.tableUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async checkConnection(): Promise<ConnectionCheckResult> {
    return this.jsonRequest<ConnectionCheckResult>("GET", this.options.tableUrl);
  }

  async getSchema(): Promise<TableSchema> {
    return this.jsonRequest<TableSchema>("GET", `${this.options.tableUrl}/schema`);
  }

  /**
   * POST {url}. Accepts either a plain body (gzipped here) or an
   * already-gzipped Buffer, so a future streaming request builder can
   * encode rows directly into the gzip stream without this client
   * re-compressing them.
   */
  async push(body: PushRequestBody | Buffer): Promise<PushResult> {
    const gzipped = Buffer.isBuffer(body) ? body : gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
    return this.jsonRequest<PushResult>("POST", this.options.tableUrl, gzipped);
  }

  private async jsonRequest<T>(method: string, url: string, gzippedBody?: Buffer): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(url, {
        method,
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.pushKey}`,
          "content-type": "application/json",
          ...(gzippedBody ? { "content-encoding": "gzip" } : {}),
        },
        body: gzippedBody,
      });
    } catch (err) {
      throw new PlanometryTransientError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    const text = await res.body.text();

    if (res.statusCode === 401 || res.statusCode === 404) throw new PlanometryConfigError(res.statusCode);
    if (res.statusCode >= 500) throw new PlanometryTransientError(`Planometry returned ${res.statusCode}`);

    let envelope: ResponseEnvelope<T>;
    try {
      envelope = text ? (JSON.parse(text) as ResponseEnvelope<T>) : { success: res.statusCode < 300 };
    } catch {
      throw new PlanometryTransientError(`Planometry returned a non-JSON response (status ${res.statusCode})`);
    }

    if (res.statusCode === 400 || !envelope.success) {
      throw new PlanometryRejectedError(envelope.message ?? `Planometry rejected the request (status ${res.statusCode})`);
    }
    if (res.statusCode >= 300) throw new PlanometryTransientError(`Planometry returned ${res.statusCode}`);

    return envelope.data as T;
  }
}
