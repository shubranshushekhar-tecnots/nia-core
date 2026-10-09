import { defaultHomeDir, defaultLogDir, defaultSpoolDir, keyFilePath, localApiDir } from "../config/paths.js";
import { findConnection, loadConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { readJobState } from "../ops/state.js";
import { checkCancelVisibility, checkDiskSpace, checkLoginPermissions, checkTargetReachable, checkTargetSchema, probeSqlServer, type CheckResult } from "./doctorChecks.js";
import { testJob } from "./jobCommands.js";
import { checkPathPermissions, loadLocalApiExtraAllowedIdentities } from "./permissionChecks.js";

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
        checkPathPermissions("local-api directory", localApiDir(dir), loadLocalApiExtraAllowedIdentities(dir)),
      ])),
    );

    reports.push({ connectionId: entry.id, label: entry.label, checks });
  }

  return reports;
}

function mustFindConnection(config: ReturnType<typeof loadConfig>, id: string) {
  const entry = findConnection(config, id);
  if (!entry) throw new Error(`no connection with id ${JSON.stringify(id)}`);
  return entry;
}

export interface JobDoctorReport {
  jobId: string;
  name: string;
  checks: CheckResult[];
}

export interface PausedJobInfo {
  jobId: string;
  name: string;
  reason: string;
  since: string;
}

/** `agent doctor`'s per-job checks (§10 (B2) item 6) — `checkTargetReachable`/`checkTargetSchema`, both reusing `job test` rather than probing Planometry a second time. */
export async function runJobDoctor(dir = defaultHomeDir()): Promise<JobDoctorReport[]> {
  const config = loadConfig(dir);
  const reports: JobDoctorReport[] = [];
  for (const job of config.jobs) {
    const testResult = await testJob(job.id, dir);
    reports.push({ jobId: job.id, name: job.name, checks: [checkTargetReachable(testResult), checkTargetSchema(testResult)] });
  }
  return reports;
}

/** Every configured job currently paused (manually via `job pause` or by the scheduler), for `agent doctor`'s report. */
export function listPausedJobs(dir = defaultHomeDir()): PausedJobInfo[] {
  const config = loadConfig(dir);
  const paused: PausedJobInfo[] = [];
  for (const job of config.jobs) {
    const state = readJobState(job.id, dir);
    if (state.paused) paused.push({ jobId: job.id, name: job.name, reason: state.paused.reason, since: state.paused.at });
  }
  return paused;
}
