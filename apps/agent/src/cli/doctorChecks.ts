import { mkdir } from "node:fs/promises";
import { Agent, ProxyAgent, request as undiciRequest } from "undici";
import { connect, introspectCatalog } from "@nia/extract/mssql";
import { resolveProxyUrl } from "../planometry/network.js";
import { assertDiskSpace, InsufficientDiskSpaceError } from "../sync/diskSpace.js";
import type { ConnectionEntry } from "../config/types.js";

/**
 * `nia-agent doctor` (docs/plans/planometry-integration.md Phase 3 prep):
 * per-connection diagnostic checks, each a pass/fail with a plain fix.
 * Every check only ever surfaces booleans/counts/error *messages* in
 * `detail`/`fix` — passwords and agent keys are read from the secret
 * store purely to attempt a real connection/request, never echoed back.
 */
export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  fix?: string;
  /** Only meaningful when `pass` is false: "warning" means a non-blocking, opt-in capability is missing (doesn't fail `agent doctor`'s exit code); omitted/"fail" means a hard failure. */
  severity?: "fail" | "warning";
}

export interface SqlCredentials {
  user: string;
  password: string;
}

const TLS_ERROR_PATTERN = /ssl|tls|certificate|handshake|self signed/i;
const WRITE_PERMISSIONS = new Set(["INSERT", "UPDATE", "DELETE", "ALTER", "CONTROL"]);
const CLOCK_SKEW_FAIL_MS = 5 * 60 * 1000;

/** Avoids a direct dependency on the `mssql`/`@types/mssql` package from apps/agent — derived structurally from `@nia/extract/mssql`'s own `connect()` return type instead. */
export type ConnectionPool = Awaited<ReturnType<typeof connect>>;

export interface SqlServerProbeResult {
  reachable: CheckResult;
  tls: CheckResult;
  /** Authentication outcome — distinct from `reachable`/`tls` so a bad password always surfaces as its own failing check, even though no pool is available to run checkLoginPermissions/checkCancelVisibility against. */
  login: CheckResult;
  /** Set only when the connection fully succeeded — caller is responsible for closing it. */
  pool?: ConnectionPool;
}

/** One connection attempt, classified into "reachable" (network layer), "TLS mode" (handshake) and "login" (authentication), covering §2's checks without duplicating the connect. */
export async function probeSqlServer(entry: ConnectionEntry, credentials: SqlCredentials): Promise<SqlServerProbeResult> {
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
    return {
      reachable: { name: "SQL Server reachable", pass: true, detail: `connected to ${entry.sqlserver.host}:${entry.sqlserver.port ?? 1433}` },
      tls: { name: "TLS mode works", pass: true, detail: "TLS handshake succeeded with the configured settings" },
      login: { name: "login credentials accepted", pass: true, detail: `authenticated as ${credentials.user}` },
      pool,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;

    if (code === "ELOGIN") {
      // Got past TCP + TLS, failed at authentication.
      return {
        reachable: { name: "SQL Server reachable", pass: true, detail: `connected to ${entry.sqlserver.host}:${entry.sqlserver.port ?? 1433}` },
        tls: { name: "TLS mode works", pass: true, detail: "TLS handshake succeeded with the configured settings" },
        login: {
          name: "login credentials accepted",
          pass: false,
          detail: `authentication failed for user ${credentials.user}`,
          fix: "verify the stored credentials are current (`nia-agent connection add` to update them), or regenerate the login via `nia-agent sql readonly`",
        },
      };
    }

    if (TLS_ERROR_PATTERN.test(message)) {
      return {
        reachable: { name: "SQL Server reachable", pass: false, detail: message },
        tls: {
          name: "TLS mode works",
          pass: false,
          detail: message,
          fix: "toggle `encrypt`/`allowLegacyTls`/`trustServerCertificate` for this connection — SQL Server 2008 can't negotiate TLS 1.2+, so a 2008 instance over a private LAN typically needs encrypt: false, or allowLegacyTls: true if encryption is required",
        },
        login: { name: "login credentials accepted", pass: false, detail: "skipped — SQL Server was not reachable" },
      };
    }

    return {
      reachable: {
        name: "SQL Server reachable",
        pass: false,
        detail: `${message}${code ? ` (code ${code})` : ""}`,
        fix: "check firewall/VPN rules and that the host:port in this connection's config is correct",
      },
      tls: { name: "TLS mode works", pass: false, detail: "skipped — SQL Server was not reachable" },
      login: { name: "login credentials accepted", pass: false, detail: "skipped — SQL Server was not reachable" },
    };
  }
}

/** "can read", "can see catalog" (introspection succeeds) and "can't write" (fn_my_permissions, never a real write attempt). */
export async function checkLoginPermissions(pool: ConnectionPool): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const catalog = await introspectCatalog(pool, "UTC");
    results.push({ name: "can read / see catalog", pass: catalog.tables.length > 0, detail: `${catalog.tables.length} table(s)/view(s) visible via INFORMATION_SCHEMA`, fix: catalog.tables.length > 0 ? undefined : "grant db_datareader + VIEW DEFINITION to this login on the target database (see `nia-agent sql readonly`)" });
  } catch (err) {
    results.push({ name: "can read / see catalog", pass: false, detail: err instanceof Error ? err.message : String(err), fix: "grant db_datareader + VIEW DEFINITION to this login on the target database (see `nia-agent sql readonly`)" });
  }

  try {
    // Read-only permissions inventory — never issues a real write against the customer's database to prove this.
    const result = await pool.request().query<{ permission_name: string }>("SELECT permission_name FROM fn_my_permissions(NULL, 'DATABASE')");
    const grantedWritePermissions = result.recordset.map((r: { permission_name: string }) => r.permission_name.toUpperCase()).filter((p: string) => WRITE_PERMISSIONS.has(p));
    results.push({
      name: "login can't write",
      pass: grantedWritePermissions.length === 0,
      detail: grantedWritePermissions.length === 0 ? "no write permissions granted at the database level" : `write permissions granted: ${grantedWritePermissions.join(", ")}`,
      fix: grantedWritePermissions.length === 0 ? undefined : "revoke write permissions/roles (db_datawriter, db_owner, explicit INSERT/UPDATE/DELETE/ALTER/CONTROL grants) — this login should only have db_datareader + VIEW DEFINITION",
    });
  } catch (err) {
    results.push({ name: "login can't write", pass: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return results;
}

/** VIEW SERVER STATE visibility — required for cancel-confirmation (sys.dm_exec_requests), same DMV the extract module's integration tests use. Opt-in on the grant side (`nia-agent sql readonly --with-cancel-visibility`), so a missing grant is a WARNING here, not a hard failure. */
export async function checkCancelVisibility(pool: ConnectionPool): Promise<CheckResult> {
  try {
    await pool.request().query("SELECT COUNT(*) AS c FROM sys.dm_exec_requests");
    return { name: "sys.dm_exec_requests visible (cancel confirmation)", pass: true, detail: "query succeeded" };
  } catch (err) {
    return {
      name: "sys.dm_exec_requests visible (cancel confirmation)",
      pass: false,
      severity: "warning",
      detail: err instanceof Error ? err.message : String(err),
      fix: "GRANT VIEW SERVER STATE to this login (see `nia-agent sql readonly --with-cancel-visibility`) — optional, only needed for cancel confirmation",
    };
  }
}

/** Wraps sync/diskSpace.ts's existing free-space check. Creates `spoolDir` first if it doesn't exist yet (same as the real sync path's `SpoolWriter.prepare()` would do on its first run) — doctor is meant to be run pre-flight, before the spool dir necessarily exists. */
export async function checkDiskSpace(spoolDir: string): Promise<CheckResult> {
  try {
    await mkdir(spoolDir, { recursive: true });
    await assertDiskSpace(spoolDir);
    return { name: "spool directory free disk space", pass: true, detail: `sufficient free space in ${spoolDir}` };
  } catch (err) {
    if (err instanceof InsufficientDiskSpaceError) {
      return { name: "spool directory free disk space", pass: false, detail: `${err.freeBytes} bytes free, ${err.requiredBytes} required in ${err.dir}`, fix: "free up disk space or point spoolDir at a volume with more room" };
    }
    return { name: "spool directory free disk space", pass: false, detail: err instanceof Error ? err.message : String(err), fix: `ensure ${spoolDir} exists and is accessible` };
  }
}

export interface PlanometryProbeResult {
  reachable: CheckResult;
  clockSkew: CheckResult;
}

/** One lightweight HTTP request to Planometry's baseUrl, reusing the same proxy/CA dispatcher logic as PlanometryClient, covering both reachability and clock-skew (via the response's Date header) without a second round trip. */
export async function probePlanometry(baseUrl: string, caBundlePem?: string): Promise<PlanometryProbeResult> {
  try {
    const proxyUrl = resolveProxyUrl(baseUrl);
    const requestTls = caBundlePem ? { ca: caBundlePem } : undefined;
    const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls }) : new Agent({ connect: requestTls });
    try {
      const res = await undiciRequest(baseUrl, { method: "GET", dispatcher });
      await res.body.text();
      const dateHeader = res.headers.date;
      const serverDate = typeof dateHeader === "string" ? Date.parse(dateHeader) : NaN;
      const reachable: CheckResult = { name: "Planometry URL reachable", pass: true, detail: `${baseUrl} responded with HTTP ${res.statusCode}` };
      if (Number.isNaN(serverDate)) {
        return { reachable, clockSkew: { name: "clock skew", pass: true, detail: "Planometry's response had no usable Date header — skipped" } };
      }
      const skewMs = Math.abs(Date.now() - serverDate);
      return {
        reachable,
        clockSkew: {
          name: "clock skew",
          pass: skewMs <= CLOCK_SKEW_FAIL_MS,
          detail: `${Math.round(skewMs / 1000)}s skew vs Planometry's clock`,
          fix: skewMs <= CLOCK_SKEW_FAIL_MS ? undefined : "sync this host's clock via NTP",
        },
      };
    } finally {
      await dispatcher.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: { name: "Planometry URL reachable", pass: false, detail: message, fix: "check network/proxy/CA settings for this connection's planometry.baseUrl" },
      clockSkew: { name: "clock skew", pass: false, detail: "skipped — Planometry was not reachable" },
    };
  }
}

// The old agent-key-accepted ping check (PlanometryClient.ping against the
// work-queue protocol) was removed in the v4 migration's slice A1
// (docs/plans/planometry-v4-migration.md §10, §982) — a later slice adds
// its v4 replacement (checkTargetReachable/checkTargetSchema).
