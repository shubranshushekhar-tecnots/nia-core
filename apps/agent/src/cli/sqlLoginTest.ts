import { connect } from "@nia/extract/mssql";

export interface SqlLoginTestInput {
  host: string;
  port?: number;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export type SqlLoginTestResult = { ok: true; databases: string[] } | { ok: false; reason: string };

/**
 * `nia-agent setup`'s database step: connects to `master` with the given
 * login (no database chosen yet) and lists every database that login can
 * see, via `HAS_DBACCESS` — same read-only, no-write probe style as
 * cli/doctorChecks.ts's `probeSqlServer`. Never throws; failures are
 * classified into a plain reason by `classifySqlLoginError`.
 */
export async function testSqlLoginAndListDatabases(input: SqlLoginTestInput): Promise<SqlLoginTestResult> {
  try {
    const pool = await connect({
      server: input.host,
      port: input.port,
      database: "master",
      user: input.user,
      password: input.password,
      encrypt: input.encrypt,
      trustServerCertificate: input.trustServerCertificate,
    });
    try {
      const result = await pool.request().query<{ name: string }>(
        "SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name",
      );
      return { ok: true, databases: result.recordset.map((r) => r.name) };
    } finally {
      await pool.close();
    }
  } catch (err) {
    return { ok: false, reason: classifySqlLoginError(err) };
  }
}

/** Exported for unit testing without a real SQL Server. Never includes the password — only `err`'s own message/code. */
export function classifySqlLoginError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);

  // SQL Server's actual client-visible text for "SQL login attempted while
  // the server is configured for Windows Authentication mode only" is Error
  // 18452: "Login failed for user '...'. The user is not associated with a
  // trusted SQL Server connection." -- it never literally says "Windows
  // Authentication". Confirmed against a real SQL Server Express instance
  // in Windows-only mode (Windows installer CI, check C3) after the
  // previous regex here (matching "windows authentication") never once
  // matched and fell through to the generic ELOGIN "wrong password" case.
  if (/not associated with a trusted sql server connection/i.test(message)) {
    return "password logins are switched off on this server (it only accepts Windows sign-in)";
  }
  if (code === "ELOGIN") {
    return "wrong username or password";
  }
  // Checked before the generic ESOCKET/timeout bucket below: a TLS/certificate
  // handshake failure (e.g. the server's default self-signed certificate isn't
  // trusted) also surfaces from tedious as ESOCKET, and would otherwise be
  // misreported as a plain unreachable-host error — same distinction
  // doctorChecks.ts's TLS_ERROR_PATTERN already makes for `agent doctor`.
  if (/ssl|tls|certificate|handshake|self signed/i.test(message)) {
    return "couldn't verify this server's TLS certificate (it's likely self-signed) — ask your DBA for a trusted certificate, or re-run setup against this server once it's reachable on your local network";
  }
  if (code === "ESOCKET" || code === "ETIMEOUT" || /ECONNREFUSED|getaddrinfo|timed? ?out/i.test(message)) {
    return "server not reachable on that host/port";
  }
  return message;
}
