/**
 * Non-secret connection/job config. Matches docs/plans/planometry-
 * v4-migration.md §9: one agent.config.json per install, a list of
 * connections and a list of sync jobs, credentials/push keys always
 * referenced via the local secret store (secrets/store.ts), never
 * inlined here.
 */
import type { ColumnType } from "../planometry/types.js";
import type { JobFilterCondition } from "../planometry/parameters.js";

export interface SqlServerConnectionConfig {
  host: string;
  port?: number;
  database: string;
  encrypt?: boolean;
  allowLegacyTls?: boolean;
  trustServerCertificate?: boolean;
}

export interface ConnectionEntry {
  id: string;
  label: string;
  sqlserver: SqlServerConnectionConfig;
  /** IANA time zone name (e.g. "America/New_York"), validated at `connection add`. Used for catalog introspection and (later) cron-schedule evaluation. */
  sourceTimeZone: string;
  /** Ref into the local secret store for `{ user, password }`. */
  credentialRef: string;
  /** Ref into the local secret store for `{ agentKey }`. */
  agentKeyRef: string;
}

/** One mapped source column -> target column pair. */
export interface JobMappingColumn {
  source: string;
  target: string;
}

/**
 * "replace" (full reload, every run) or "upsertDelta" (watermark-based
 * incremental sync, slice C1 — docs/plans/planometry-v4-migration.md
 * §1.1/§10). `realtime` and other strategies are later slices.
 */
export type JobStrategy = "replace" | "upsertDelta";

export interface TargetSchemaColumnSnapshot {
  name: string;
  type: ColumnType;
  isKey: boolean;
}

/** The target table's `/schema` shape as it was at `job add`/last successful `job update` time — compared against the live `/schema` by `job test`/future runs to detect drift (docs/plans/planometry-v4-migration.md §6). */
export interface TargetSchemaSnapshot {
  columns: TargetSchemaColumnSnapshot[];
  keyColumns: string[];
}

/** §7 "Safety rules": a null/empty-string key value either stops the run (default) or is dropped and counted. */
export type OnNullKey = "stop" | "skip";

/**
 * `strategy: "upsertDelta"` only (§1.2): "none" (default) never removes
 * rows; "reconciliation" (slice D1) keeps a saved key list and, on every
 * delta run, deletes keys that disappeared from the source or left the
 * job's filter, guarded by `maxDeletePercent`/`--allow-mass-delete`;
 * "softDelete" (slice D2) treats a boolean source column as "this row is
 * deleted" — a delta/param-override run sends a flagged row as a delete
 * instead of an upsert, a replace excludes flagged rows entirely. No
 * mass-delete guard applies to "softDelete".
 */
export type DeleteMode = "none" | "reconciliation" | "softDelete";

export interface SyncJobEntry {
  id: string;
  name: string;
  connectionId: string;
  /** Catalog-exact source table/view name (e.g. "dbo.vw_salesdata"). */
  sourceTable: string;
  /** Planometry Internal Table push URL. */
  targetUrl: string;
  /** Ref into the local secret store for `{ pushKey }`. */
  pushKeyRef: string;
  strategy: JobStrategy;
  mapping: JobMappingColumn[];
  targetSchemaSnapshot: TargetSchemaSnapshot;
  /** §7: default "stop". */
  onNullKey: OnNullKey;
  /** §7: a zero-row replace is refused unless this is true. Default false. */
  allowEmptyReplace: boolean;
  /** AND-joined; may reference `params` by name (§2, §10 slice B1). Filter columns need not be in `mapping`. */
  filter: JobFilterCondition[];
  /** Saved named-parameter values (always raw strings, including relative-date tokens stored as literal token text — resolved only at validation/run time). Overridable per-run via `job run --param`, which never mutates this. */
  params: Record<string, string>;
  /** 5-field cron expression (minute hour day-of-month month day-of-week), evaluated in the connection's `sourceTimeZone` by the scheduler (scheduler/cronSchedule.ts). Unset: the job runs only via `job run`, never on a timer. For an `upsertDelta` job this is the delta cadence; `replaceSchedule` below is the separate periodic full-reload cadence. */
  schedule?: string;
  /** `strategy: "upsertDelta"` only: the date-time watermark column (no-offset family — datetime/datetime2/smalldatetime), read even when not in `mapping` (§1.1). Required for `upsertDelta`, absent for `replace`. */
  watermarkColumn?: string;
  /** `strategy: "upsertDelta"` only: overlap window in seconds subtracted from the computed watermark (§1.1). Default 300, applied where read, not stored as a literal default here. */
  overlapSeconds?: number;
  /** A separate cron expression (same format/timezone as `schedule`) for a periodic full `replace`, independent of `schedule`'s delta cadence (§2, §8). Required when the job's filter uses a relative-date parameter. */
  replaceSchedule?: string;
  /** `strategy: "upsertDelta"` only (§1.2): default "none". Any non-"none" value requires `strategy === "upsertDelta"`. */
  deleteMode?: DeleteMode;
  /** `deleteMode: "reconciliation"` only: mass-delete guard threshold, percent of the saved key list (§7/D1). Default 20, applied where read, not stored as a literal default here. */
  maxDeletePercent?: number;
  /** `deleteMode: "softDelete"` only (§1.2, slice D2): a boolean source column, read even when not in `mapping` and never sent to Planometry — `true` means the row is deleted. */
  softDeleteColumn?: string;
}

/**
 * Optional monitoring heartbeat (Phase 3b §3: "an optional heartbeat to a
 * configurable URL... off by default, no customer data — only agent
 * version, connection ids, last-success times, error counts").
 */
export interface MonitoringConfig {
  heartbeatUrl?: string;
  intervalSeconds?: number;
}

export interface AgentConfig {
  version: 1;
  /** Defaults under the same app-data dir as the config file itself — see paths.ts. */
  spoolDir?: string;
  /** Unset by default — no heartbeat is sent unless explicitly configured. */
  monitoring?: MonitoringConfig;
  /** Global cap on simultaneously running jobs, scheduler-enforced (docs/plans/planometry-v4-migration.md §8). Default 1. */
  maxConcurrentRuns?: number;
  connections: ConnectionEntry[];
  jobs: SyncJobEntry[];
}

export const CURRENT_CONFIG_VERSION = 1;

export function emptyConfig(): AgentConfig {
  return { version: CURRENT_CONFIG_VERSION, connections: [], jobs: [] };
}
