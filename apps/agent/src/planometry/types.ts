/**
 * v4 Internal Table push wire types (docs/planometry/connector-guide-v4.md
 * §2-§4; docs/plans/planometry-v4-migration.md §10 slice A1). One table =
 * one URL + one push key; no work queue, no catalog push, no chunk/run
 * protocol — that entire model is gone as of this slice.
 */

export type PushMode = "upsert" | "replace" | "delete" | "realtime";

export type ColumnType = "Text" | "Number" | "Date" | "DateTime" | "Boolean";

export interface SchemaColumn {
  name: string;
  type: ColumnType;
  isKey: boolean;
}

/** GET {url}/schema response data (guide §2.2). */
export interface TableSchema {
  dataSourceId: string;
  dataSourceName: string;
  columns: SchemaColumn[];
  keyColumns: string[];
  supportedModes: PushMode[];
  maxRowsPerRequest: number;
  rowCount: number;
  rowsUpdatedAt: string | null;
  version: number;
}

/** GET {url} response data (guide §2.1). */
export interface ConnectionCheckResult {
  status: "ok";
  dataSourceId: string;
  dataSourceName: string;
  serverTime: string;
}

/** A single pushed row: column name -> value. */
export type PlanometryRow = Record<string, unknown>;

/** POST {url} request body (guide §2.3). */
export interface PushRequestBody {
  mode: PushMode;
  rows?: PlanometryRow[];
  deleted?: PlanometryRow[];
  loadId?: string;
  last?: boolean;
  totalRows?: number;
}

/** POST {url} response data (guide §2.3). */
export interface PushResult {
  mode: PushMode;
  status: "accepted" | "completed";
  rowCount?: number;
  rowsAffected?: number;
  rowsDeleted?: number;
  version?: number;
  completedAt?: string;
  loadId?: string;
  loadRowsReceived?: number;
}

/** Envelope every v4 endpoint responds with (guide §2). */
export interface ResponseEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}
