import sql from "mssql";

export interface MssqlConnectionConfig {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  /**
   * Defaults to true. Set `false` only for a LAN-only/private-network
   * instance with no public exposure (e.g. GMS's SQL Server 2008 boxes,
   * reached only from an on-premise Nia Agent on the customer's own
   * network) — never for anything reachable over the public internet.
   */
  encrypt?: boolean;
  /** Defaults to false; set true only for a throwaway/self-signed test instance. */
  trustServerCertificate?: boolean;
  /**
   * !! INSECURE — OFF by default. SQL Server 2008 (and older TLS
   * stacks in general) can't negotiate TLS 1.2+, so `encrypt: true`
   * against it fails the handshake outright. Setting this `true`:
   *   1. drops the minimum negotiated protocol to TLS 1.0
   *      (`cryptoCredentialsDetails.minVersion`), and
   *   2. appends `@SECLEVEL=0` to the cipher list, because OpenSSL 3.x's
   *      default security level (2) refuses TLS 1.0's older ciphers
   *      outright regardless of `minVersion` — without this the
   *      handshake still fails even with `minVersion` lowered.
   * TLS 1.0 is cryptographically broken (BEAST, POODLE-adjacent padding
   * issues, no modern AEAD ciphers). This exists ONLY for an on-premise
   * Nia Agent talking to a legacy SQL Server over a private, trusted
   * customer LAN that the agent already has direct (non-internet) access
   * to — never enable this for any connection reachable from, or
   * proxied over, the public internet. Prefer leaving TLS off via
   * `encrypt: false` (SQL Server 2008's default anyway) over turning
   * this on wherever the LAN itself is trusted and `encrypt: false` is
   * acceptable.
   */
  allowLegacyTls?: boolean;
  connectTimeoutMs?: number;
}

/**
 * Pure translation from this module's config to the `mssql`/tedious pool
 * config — split out from `connect()` so the TLS/encrypt logic is
 * testable without opening a real socket.
 */
export function buildPoolConfig(config: MssqlConnectionConfig): sql.config {
  return {
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
      ...(config.allowLegacyTls
        ? { cryptoCredentialsDetails: { minVersion: "TLSv1" as const, ciphers: "DEFAULT:@SECLEVEL=0" } }
        : {}),
    },
  };
}

/**
 * SQL logins only for now (per the spec). Windows Authentication would
 * additionally need: the `msnodesqlv8` native driver (not `tedious`, the
 * pure-JS driver this module uses) or `tedious`'s own experimental NTLM/
 * Kerberos support; a Windows host (or a Linux host joined to the domain
 * via `realm`/`sssd` for Kerberos); and domain connectivity (a reachable
 * KDC/domain controller) — not built here.
 *
 * One connection = one database (the `database` field is required), by
 * design — a server with several databases (e.g. GMS's seven
 * `SummitERP_*` databases on one SQL Server 2008 instance) is modelled
 * as one `MssqlConnectionConfig`/`connect()` call per database, never a
 * single connection spanning several. Nothing in this module or
 * catalog.ts/types.ts assumes there's only one database on the server.
 */
export async function connect(config: MssqlConnectionConfig): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(buildPoolConfig(config));
  return pool.connect();
}
