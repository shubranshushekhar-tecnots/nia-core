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

/** Only "replace" exists until slice C1 adds `upsertDelta`/other strategies behind the `--strategy` flag. */
export type JobStrategy = "replace";

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
  /** 5-field cron expression (minute hour day-of-month month day-of-week), evaluated in the connection's `sourceTimeZone` by the scheduler (scheduler/cronSchedule.ts). Unset: the job runs only via `job run`, never on a timer. */
  schedule?: string;
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
