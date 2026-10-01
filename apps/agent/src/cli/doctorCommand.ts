import { defaultHomeDir, defaultLogDir, defaultSpoolDir, keyFilePath } from "../config/paths.js";
import { findConnection, loadConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { checkAgentKeyAccepted, checkCancelVisibility, checkDiskSpace, checkLoginPermissions, probePlanometry, probeSqlServer, type CheckResult } from "./doctorChecks.js";
import { checkPathPermissions } from "./permissionChecks.js";

export interface ConnectionDoctorReport {
  connectionId: string;
  label: string;
  checks: CheckResult[];
}

/** `nia-agent doctor [connectionId]`: runs every diagnostic check for one connection, or all of them if none is given. Never prints a password or agent key — only reads them out of the local secret store to attempt a real connection/request. */
export async function runDoctor(connectionId: string | undefined, dir = defaultHomeDir()): Promise<ConnectionDoctorReport[]> {
  const config = loadConfig(dir);
  const entries = connectionId ? [mustFindConnection(config, connectionId)] : config.connections;
  if (connectionId === undefined && entries.length === 0) {
    return [];
  }

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);

  const reports: ConnectionDoctorReport[] = [];
  for (const entry of entries) {
    const checks: CheckResult[] = [];
    const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
    const agentKey = secrets.get<{ agentKey: string }>(entry.agentKeyRef);

    if (!credentials) {
      checks.push({ name: "SQL Server reachable", pass: false, detail: "credentials are missing from the local secret store" });
    } else {
      const { reachable, tls, login, pool } = await probeSqlServer(entry, credentials);
      checks.push(reachable, tls, login);
      if (pool) {
        try {
          checks.push(...(await checkLoginPermissions(pool)));
          checks.push(await checkCancelVisibility(pool));
        } finally {
          await pool.close();
        }
      }
    }

    checks.push(await checkDiskSpace(defaultSpoolDir(dir)));
    checks.push(
      ...(await Promise.all([
        checkPathPermissions("agent data directory", dir),
        checkPathPermissions("secrets keyfile", keyFilePath(dir)),
        checkPathPermissions("spool directory", defaultSpoolDir(dir)),
        checkPathPermissions("log directory", defaultLogDir(dir)),
      ])),
    );

    const { reachable: planometryReachable, clockSkew } = await probePlanometry(entry.planometry.baseUrl);
    checks.push(planometryReachable, clockSkew);
    if (planometryReachable.pass) {
      if (!agentKey) {
        checks.push({ name: "agent key accepted", pass: false, detail: "agent key is missing from the local secret store" });
      } else {
        checks.push(await checkAgentKeyAccepted(entry.planometry.baseUrl, agentKey.agentKey, entry.planometry.pingPath));
      }
    }

    reports.push({ connectionId: entry.id, label: entry.label, checks });
  }

  return reports;
}

function mustFindConnection(config: ReturnType<typeof loadConfig>, id: string) {
  const entry = findConnection(config, id);
  if (!entry) throw new Error(`no connection with id ${JSON.stringify(id)}`);
  return entry;
}
