import { connect, introspectCatalog } from "@nia/extract/mssql";
import { defaultHomeDir } from "../config/paths.js";
import { findConnection, loadConfig, removeConnection as removeFromConfig, saveConfig, upsertConnection } from "../config/store.js";
import type { ConnectionEntry, PlanometryConnectionConfig, SqlServerConnectionConfig } from "../config/types.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";

export interface AddConnectionInput {
  id: string;
  label: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt?: boolean;
  allowLegacyTls?: boolean;
  trustServerCertificate?: boolean;
  planometryBaseUrl: string;
  agentKey: string;
  heartbeatPath?: string;
}

/** `nia-agent connection add`: stores credentials in the local secret store, non-secret shape in agent.config.json. Does not validate connectivity — use `connection test` for that. */
export function addConnection(input: AddConnectionInput, dir = defaultHomeDir()): ConnectionEntry {
  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);

  const credentialRef = secrets.put({ user: input.user, password: input.password });
  const agentKeyRef = secrets.put({ agentKey: input.agentKey });

  const sqlserver: SqlServerConnectionConfig = {
    host: input.host,
    port: input.port,
    database: input.database,
    encrypt: input.encrypt,
    allowLegacyTls: input.allowLegacyTls,
    trustServerCertificate: input.trustServerCertificate,
  };
  const planometry: PlanometryConnectionConfig = {
    baseUrl: input.planometryBaseUrl,
    heartbeatPath: input.heartbeatPath,
  };
  const entry: ConnectionEntry = { id: input.id, label: input.label, sqlserver, planometry, credentialRef, agentKeyRef };

  const config = loadConfig(dir);
  saveConfig(upsertConnection(config, entry), dir);
  return entry;
}

/** `nia-agent connection list`: non-secret config only — never prints credentials. */
export function listConnections(dir = defaultHomeDir()): ConnectionEntry[] {
  return loadConfig(dir).connections;
}

/** `nia-agent connection remove <id>`: deletes the config entry and its secret-store blobs. */
export function removeConnection(id: string, dir = defaultHomeDir()): boolean {
  const config = loadConfig(dir);
  const entry = findConnection(config, id);
  if (!entry) return false;

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  secrets.delete(entry.credentialRef);
  secrets.delete(entry.agentKeyRef);

  saveConfig(removeFromConfig(config, id), dir);
  return true;
}

export interface TestConnectionResult {
  ok: boolean;
  tableCount?: number;
  error?: string;
}

/** `nia-agent connection test <id>`: connects to SQL Server and runs introspection, same code path the real sync will use — proves the stored config/credentials actually work before Planometry is involved. */
export async function testConnection(id: string, dir = defaultHomeDir()): Promise<TestConnectionResult> {
  const config = loadConfig(dir);
  const entry = findConnection(config, id);
  if (!entry) return { ok: false, error: `no connection with id ${JSON.stringify(id)}` };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
  if (!credentials) return { ok: false, error: `credentials for ${id} are missing from the secret store` };

  try {
    const pool = await connect({
      server: entry.sqlserver.host,
      port: entry.sqlserver.port,
      database: entry.sqlserver.database,
      user: credentials.user,
      password: credentials.password,
      encrypt: entry.sqlserver.encrypt,
      allowLegacyTls: entry.sqlserver.allowLegacyTls,
      trustServerCertificate: entry.sqlserver.trustServerCertificate,
    });
    try {
      const catalog = await introspectCatalog(pool, "UTC");
      return { ok: true, tableCount: catalog.tables.length };
    } finally {
      await pool.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
