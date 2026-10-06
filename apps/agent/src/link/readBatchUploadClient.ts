import { gzipSync } from "node:zlib";
import { Agent, ProxyAgent, request, type Dispatcher } from "undici";
import { resolveProxyUrl } from "../planometry/network.js";
import type { StructuredQueryCursor } from "./transport.js";

/**
 * Mirrors services/agent-bridge/src/app.ts's UploadedBatchBody exactly —
 * in particular `columns[].type` is the bridge's own wire-level
 * `ColumnType` (packages/schemas/src/tabular.ts), a 7-value enum that is
 * NOT the same set as this package's `ExtractType` (packages/extract/
 * src/types.ts's 5-value "text"/"number"/"date"/"datetime"/"boolean").
 * Callers must map through `extractTypeToColumnType` (taskRunner.ts)
 * before building this object — never pass an `ExtractType` straight
 * through, the bridge's zod validation rejects "text"/"datetime" outright.
 */
export interface UploadedBatch {
  cursor: StructuredQueryCursor | null;
  columns: { name: string; type: "string" | "number" | "boolean" | "date" | "json" | "binary" | "unknown" }[];
  rows: unknown[][];
  nextCursor: StructuredQueryCursor | null;
  isLast: boolean;
}

export interface ReadBatchUploadClientOptions {
  platformUrl: string;
  agentKey: string;
  /** PEM contents for a custom CA bundle — same knob as HttpAgentTransport/TaskResultsClient. */
  caBundlePem?: string;
  /** Per-request ceiling. Defaults to 20s — bigger batches take longer to gzip/transfer than a plain task-result post. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class BatchTooLargeError extends Error {}

/**
 * Slice T2, plan point 3 — "a dedicated authenticated call for the agent
 * to upload a batch: compressed JSON, at most 20 MB per batch". Gzips the
 * batch client-side (same cap the bridge enforces server-side, see
 * app.ts's READ_BATCH_UPLOAD_MAX_BYTES) and POSTs to
 * `/agent-api/read-batches/:taskId`, mirroring HttpAgentTransport/
 * TaskResultsClient's proxy/dispatcher pattern exactly.
 */
export class ReadBatchUploadClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly platformUrl: string;
  private readonly agentKey: string;

  constructor(private readonly options: ReadBatchUploadClientOptions) {
    this.platformUrl = options.platformUrl.replace(/\/$/, "");
    this.agentKey = options.agentKey;
    const proxyUrl = resolveProxyUrl(this.platformUrl);
    const requestTls = options.caBundlePem ? { ca: options.caBundlePem } : undefined;
    this.dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  /** Throws BatchTooLargeError (client-side, before ever sending) if the compressed batch exceeds the bridge's own 20 MB cap — same plain message the bridge itself would return. */
  async upload(taskId: string, batch: UploadedBatch, maxBytes: number): Promise<void> {
    const compressed = gzipSync(Buffer.from(JSON.stringify(batch), "utf8"));
    if (compressed.length > maxBytes) {
      throw new BatchTooLargeError("batch exceeds the 20 MB upload cap — select fewer columns and try again");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await request(`${this.platformUrl}/agent-api/read-batches/${taskId}`, {
        method: "POST",
        dispatcher: this.dispatcher,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.agentKey}`,
          "content-type": "application/gzip",
        },
        body: compressed,
      });
      const text = await res.body.text();
      if (res.statusCode >= 300) throw new Error(`bridge rejected batch upload: ${res.statusCode} ${text}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
