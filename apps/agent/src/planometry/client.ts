import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "./network.js";
import { CHUNK_ROWS_HEADER, CHUNK_SEQ_HEADER } from "./types.js";
import type { CatalogPushRequest, CompleteRunRequest, FailedRunRequest, WorkResponse } from "./types.js";

export interface PlanometryClientOptions {
  baseUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — TLS-inspecting corporate proxies (Phase 2 §6). */
  caBundlePem?: string;
  /** Reported on every call via a header (Phase 2 §7: "version reported on every poll"). */
  agentVersion: string;
}

export class ChunkRejectedError extends Error {
  constructor(public readonly seq: number) {
    super(`chunk seq ${seq} rejected with 409 (run superseded)`);
  }
}

export class PlanometryHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Planometry request failed with status ${status}: ${body}`);
  }
}

/**
 * Thin, single-attempt wire client — deliberately no retry/backoff here.
 * Chunk retry-with-same-seq and 409-abort orchestration live in the sync
 * executor (Phase 2 §4/§11 slice d), which is what needs to coordinate
 * retries with the on-disk spool.
 */
export class PlanometryClient {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly options: PlanometryClientOptions) {
    const proxyUrl = resolveProxyUrl(options.baseUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  async postCatalog(body: CatalogPushRequest): Promise<void> {
    await this.jsonRequest("POST", "/v1/catalog", body);
  }

  async pollWork(connectionId: string): Promise<WorkResponse> {
    return this.jsonRequest<WorkResponse>("GET", `/v1/work?connectionId=${encodeURIComponent(connectionId)}`);
  }

  /** Lightweight, non-claiming auth check — never touches the work queue (unlike pollWork). Path is config-overridable until Planometry confirms the real one (see planning doc's Open questions). */
  async ping(path?: string): Promise<void> {
    await this.jsonRequest("GET", path ?? "/v1/ping");
  }

  async pushChunk(runId: string, seq: number, rows: number, gzippedBody: Buffer): Promise<void> {
    const res = await request(this.url(`/v1/runs/${encodeURIComponent(runId)}/chunks`), {
      method: "POST",
      dispatcher: this.dispatcher,
      headers: {
        ...this.authHeaders(),
        [CHUNK_SEQ_HEADER]: String(seq),
        [CHUNK_ROWS_HEADER]: String(rows),
        "content-type": "application/gzip",
      },
      body: gzippedBody,
    });
    const text = await res.body.text();
    if (res.statusCode === 409) throw new ChunkRejectedError(seq);
    if (res.statusCode >= 300) throw new PlanometryHttpError(res.statusCode, text);
  }

  async heartbeat(runId: string, heartbeatPath?: string): Promise<void> {
    await this.jsonRequest("POST", heartbeatPath ?? `/v1/runs/${encodeURIComponent(runId)}/heartbeat`);
  }

  async reportComplete(runId: string, body: CompleteRunRequest): Promise<void> {
    await this.jsonRequest("POST", `/v1/runs/${encodeURIComponent(runId)}/complete`, body);
  }

  async reportFailed(runId: string, body: FailedRunRequest): Promise<void> {
    await this.jsonRequest("POST", `/v1/runs/${encodeURIComponent(runId)}/failed`, body);
  }

  private url(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.options.agentKey}`, "x-agent-version": this.options.agentVersion };
  }

  private async jsonRequest<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(this.url(path), {
      method,
      dispatcher: this.dispatcher,
      headers: { ...this.authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.body.text();
    if (res.statusCode >= 300) throw new PlanometryHttpError(res.statusCode, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
