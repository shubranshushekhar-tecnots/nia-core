import type { Catalog, ExtractRequest } from "@nia/extract";

/**
 * Wire-protocol shapes for the (guessed, config-overridable-where-noted)
 * Planometry push API — docs/plans/planometry-integration.md Phase 2 §4.
 * Shared between the real client (planometry/client.ts) and the fake
 * server (testing/fakePlanometryServer.ts) so both sides can never drift
 * out of sync with each other, even though they may both need to change
 * once Planometry confirms the real contract.
 */

export interface CatalogPushRequest {
  connectionId: string;
  fingerprint: string;
  catalog: Catalog;
}

export interface WorkItem {
  runId: string;
  request: ExtractRequest;
  /** Set when Planometry wants a fresh catalog push before/alongside this run. */
  catalogRequested?: boolean;
}

export interface WorkResponse {
  work: WorkItem | null;
  /** Client re-polls after this many seconds (plus its own small jitter). */
  pollAfterSeconds: number;
}

export interface CompleteRunRequest {
  totalRows: number;
  totalChunks: number;
}

export interface FailedRunRequest {
  error: string;
}

export const CHUNK_SEQ_HEADER = "x-chunk-seq";
/**
 * Row count for *this* chunk only. Lets the fake server (and, in principle,
 * a real backend) verify/aggregate row counts without needing to parse the
 * gzipped NDJSON body — the exact on-disk chunk format is Slice d's
 * concern, not this wire contract's.
 */
export const CHUNK_ROWS_HEADER = "x-chunk-rows";
