import { connect } from "@nia/extract/mssql";

export interface SqlLoginTestInput {
  host: string;
  /** Named instance (e.g. "SQL2008ERP") -- mutually exclusive with `port`. */
  instanceName?: string;
  port?: number;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  allowLegacyTls?: boolean;
}

/**
 * What kind of problem a failed login/connect attempt was, so
 * `databaseStep` can react differently per kind instead of always
 * looping back to "try the username and password again" -- e.g. offer
 * to trust a self-signed certificate, or offer legacy-TLS compatibility,
 * neither of which a wrong username/password would ever fix.
 */
export type SqlLoginFailureKind =
  | "wrongCredentials"
  | "windowsAuthOnly"
  | "unreachable"
  | "wrongPortOrInstance"
  | "tlsCertUntrusted"
  | "tlsProtocolTooOld"
  | "databaseNotFound"
  | "unknown";

export type SqlLoginTestResult =
  | { ok: true; databases: string[] }
  | { ok: false; reason: string; kind: SqlLoginFailureKind };

/**
 * `nia-agent setup`'s database step: connects to `master` with the given
 * login (no database chosen yet) and lists every database that login can
 * see, via `HAS_DBACCESS` — same read-only, no-write probe style as
 * cli/doctorChecks.ts's `probeSqlServer`. Never throws; failures are
 * classified into a plain reason + `kind` by `classifySqlLoginError`.
 */
export async function testSqlLoginAndListDatabases(input: SqlLoginTestInput): Promise<SqlLoginTestResult> {
  try {
    const pool = await connect({
      server: input.host,
      instanceName: input.instanceName,
      port: input.port,
      database: "master",
      user: input.user,
      password: input.password,
      encrypt: input.encrypt,
      trustServerCertificate: input.trustServerCertificate,
      allowLegacyTls: input.allowLegacyTls,
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
    return { ok: false, ...classifySqlLoginError(err) };
  }
}

export interface SqlLoginAutoRetryResult {
  result: SqlLoginTestResult;
  /** True if a `tlsCertUntrusted` failure was silently retried with `trustServerCertificate: true`. */
  autoTrustedCertificate: boolean;
  /** True if a `tlsProtocolTooOld` failure was silently retried with `allowLegacyTls: true`. */
  autoAllowedLegacyTls: boolean;
}

/**
 * Shared by `cli/setupCommand.ts`'s `databaseStep` and the local API's
 * `POST /connections/test` route: retries the SAME credentials with
 * adjusted TLS settings (never re-prompts/re-sends a different login) —
 * a certificate or legacy-TLS problem is never fixed by a different
 * login. Per the "minimum hassle" rule, neither a self-signed
 * certificate nor an old TLS version is ever surfaced as a question to
 * the caller — both have exactly one safe response for a database
 * server the customer themselves configured (trust it / allow it), so
 * this silently does that and retries; what was auto-enabled is
 * reported back via `autoTrustedCertificate`/`autoAllowedLegacyTls` so
 * the caller can tell the user what happened, without ever asking a
 * question first.
 *
 * `pickedInstanceLoginMode` (Windows only): when the caller already
 * knows -- from the registry, via `detectWindowsSqlInstances` -- that
 * the picked instance is in Windows-only auth mode, that's trusted over
 * the driver's necessarily-generic "Login failed" error (see
 * `WindowsSqlInstance.loginMode`'s doc comment for why), and the
 * returned `result`'s `kind`/`reason` are overridden to `windowsAuthOnly`
 * accordingly.
 */
export async function testSqlLoginWithAutoRetry(
  testSqlLogin: (input: SqlLoginTestInput) => Promise<SqlLoginTestResult>,
  input: SqlLoginTestInput,
  pickedInstanceLoginMode?: number,
): Promise<SqlLoginAutoRetryResult> {
  let trustServerCertificate = input.trustServerCertificate;
  let allowLegacyTls = input.allowLegacyTls;
  let autoTrustedCertificate = false;
  let autoAllowedLegacyTls = false;
  let result: SqlLoginTestResult;

  for (;;) {
    result = await testSqlLogin({ ...input, trustServerCertificate, allowLegacyTls });
    if (result.ok) break;

    const kind = pickedInstanceLoginMode === 1 ? "windowsAuthOnly" : result.kind;

    if (kind === "tlsCertUntrusted" && trustServerCertificate !== true) {
      trustServerCertificate = true;
      autoTrustedCertificate = true;
      continue;
    }

    if (kind === "tlsProtocolTooOld" && allowLegacyTls !== true) {
      allowLegacyTls = true;
      autoAllowedLegacyTls = true;
      continue;
    }

    if (pickedInstanceLoginMode === 1 && kind !== result.kind) {
      result = { ok: false, kind: "windowsAuthOnly", reason: "password logins are switched off on this server (it only accepts Windows sign-in)" };
    }
    break;
  }

  return { result, autoTrustedCertificate, autoAllowedLegacyTls };
}

/**
 * Checked before the generic cert-untrusted regex below: a protocol-
 * version handshake failure (the client and server share no TLS version
 * in common at all -- exactly what happens against SQL Server 2008's
 * TLS 1.0-only stack under Node 22's OpenSSL 3.x, which refuses to even
 * attempt TLS 1.0 unless `allowLegacyTls` lowers the minimum version) is
 * a fundamentally different problem from "the certificate itself isn't
 * trusted": trusting the certificate can never fix a protocol mismatch,
 * only `allowLegacyTls` can. Node/OpenSSL's actual wording for this
 * varies by version/platform -- "wrong version number" is OpenSSL's
 * classic `SSL_ERROR_SSL` text, "unsupported protocol" is the newer
 * OpenSSL 3.x wording, "EPROTO" is the Node-level error code tedious
 * surfaces it under.
 */
const TLS_PROTOCOL_PATTERN = /wrong version number|unsupported protocol|EPROTO/i;

const TLS_CERT_PATTERN = /ssl|tls|certificate|handshake|self signed/i;

/** Exported for unit testing without a real SQL Server. Never includes the password — only `err`'s own message/code. */
export function classifySqlLoginError(err: unknown): { reason: string; kind: SqlLoginFailureKind } {
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
    return { kind: "windowsAuthOnly", reason: "password logins are switched off on this server (it only accepts Windows sign-in)" };
  }
  // "Cannot open database "X" requested by the login" -- the login itself
  // is fine, but the specific database it tried to default into doesn't
  // exist or isn't visible to it. Checked before the generic ELOGIN case
  // below since both are technically login-phase failures from tedious's
  // point of view.
  if (/cannot open database/i.test(message)) {
    return { kind: "databaseNotFound", reason: "that login worked, but the database it tried to open doesn't exist (or this login can't see it)" };
  }
  if (code === "ELOGIN") {
    return { kind: "wrongCredentials", reason: "wrong username or password" };
  }
  if (TLS_PROTOCOL_PATTERN.test(message)) {
    return {
      kind: "tlsProtocolTooOld",
      reason:
        "this server only supports an old TLS version (common on SQL Server 2008/2008 R2) that this agent doesn't accept by default — it can connect anyway in a lower-security \"legacy server compatibility\" mode if you trust this network",
    };
  }
  // Checked before the generic ESOCKET/timeout bucket below: a TLS/certificate
  // handshake failure (e.g. the server's default self-signed certificate isn't
  // trusted) also surfaces from tedious as ESOCKET, and would otherwise be
  // misreported as a plain unreachable-host error — same distinction
  // doctorChecks.ts's TLS_ERROR_PATTERN already makes for `agent doctor`.
  if (TLS_CERT_PATTERN.test(message)) {
    return {
      kind: "tlsCertUntrusted",
      reason: "couldn't verify this server's TLS certificate (it's likely self-signed) — ask your DBA for a trusted certificate, or trust this server's certificate if it's on your own network",
    };
  }
  // A connection actively refused (as opposed to timing out / DNS failing)
  // means the host itself answered but nothing is listening on that exact
  // port -- usually a wrong port, or a named instance that needs its own
  // port/SQL Browser rather than the default.
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) {
    return { kind: "wrongPortOrInstance", reason: "that host is reachable, but nothing is listening on that port — check the port, or if this is a named instance, its own port or SQL Browser" };
  }
  if (code === "ESOCKET" || code === "ETIMEOUT" || /getaddrinfo|timed? ?out/i.test(message)) {
    return { kind: "unreachable", reason: "server not reachable on that host/port" };
  }
  return { kind: "unknown", reason: message };
}
