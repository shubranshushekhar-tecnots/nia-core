/**
 * Non-secret connection config. Matches docs/plans/planometry-integration.md
 * Phase 2 §2: one agent.config.json per install, a list of connections,
 * credentials/agent keys always referenced via the local secret store
 * (secrets/store.ts), never inlined here.
 */
export interface SqlServerConnectionConfig {
  host: string;
  port?: number;
  database: string;
  encrypt?: boolean;
  allowLegacyTls?: boolean;
  trustServerCertificate?: boolean;
}

export interface PlanometryConnectionConfig {
  baseUrl: string;
  /** Config-overridable until Planometry confirms the real path — see planning doc §4. */
  heartbeatPath?: string;
}

export interface ConnectionEntry {
  id: string;
  label: string;
  sqlserver: SqlServerConnectionConfig;
  planometry: PlanometryConnectionConfig;
  /** Ref into the local secret store for `{ user, password }`. */
  credentialRef: string;
  /** Ref into the local secret store for `{ agentKey }`. */
  agentKeyRef: string;
  /** sha256 of the last catalog pushed to Planometry, for schema-change detection. */
  lastCatalogFingerprint?: string;
}

export interface AgentConfig {
  version: 1;
  /** Defaults under the same app-data dir as the config file itself — see paths.ts. */
  spoolDir?: string;
  connections: ConnectionEntry[];
}

export const CURRENT_CONFIG_VERSION = 1;

export function emptyConfig(): AgentConfig {
  return { version: CURRENT_CONFIG_VERSION, connections: [] };
}
