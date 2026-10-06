import { connect } from "@nia/extract/mssql";

export interface SqlLoginTestInput {
  host: string;
  port?: number;
  user: string;
  password: string;
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

  if (/windows authentication/i.test(message)) {
    return "password logins are switched off on this server (it only accepts Windows sign-in)";
  }
  if (code === "ELOGIN") {
    return "wrong username or password";
  }
  if (code === "ESOCKET" || code === "ETIMEOUT" || /ECONNREFUSED|getaddrinfo|timed? ?out/i.test(message)) {
    return "server not reachable on that host/port";
  }
  return message;
}
