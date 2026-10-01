import sql from "mssql";

export interface MssqlConnectionConfig {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  /** Defaults to true (SQL Server requires TLS by default on recent versions). */
  encrypt?: boolean;
  /** Defaults to false; set true only for a throwaway/self-signed test instance. */
  trustServerCertificate?: boolean;
  connectTimeoutMs?: number;
}

/**
 * SQL logins only for now (per the spec). Windows Authentication would
 * additionally need: the `msnodesqlv8` native driver (not `tedious`, the
 * pure-JS driver this module uses) or `tedious`'s own experimental NTLM/
 * Kerberos support; a Windows host (or a Linux host joined to the domain
 * via `realm`/`sssd` for Kerberos); and domain connectivity (a reachable
 * KDC/domain controller) — not built here.
 */
export async function connect(config: MssqlConnectionConfig): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: config.server,
    port: config.port ?? 1433,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: config.connectTimeoutMs ?? 15_000,
    options: {
      encrypt: config.encrypt ?? true,
      trustServerCertificate: config.trustServerCertificate ?? false,
      // Never rely on driver-side timezone conversion for naive datetime
      // values — this module always selects datetime-family columns as
      // text and converts using the catalog's sourceTimeZone itself (see
      // buildSelectSql.ts), so `useUTC`'s choice of interpretation is
      // irrelevant to correctness either way; left at the driver default.
    },
  });
  return pool.connect();
}
