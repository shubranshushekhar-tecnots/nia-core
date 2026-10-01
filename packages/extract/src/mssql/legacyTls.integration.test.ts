import { describe, expect, it } from "vitest";
import { connect } from "./index.js";

/**
 * Phase 3b Slice 8 (docs/plans/planometry-integration.md): proves
 * `allowLegacyTls` (connection.ts) against a real SQL Server instance
 * forced to accept TLS 1.0 only — not just unit-testable pool-config
 * shape (see connection.test.ts), but an actual handshake.
 *
 * Requires the throwaway legacy-TLS harness running first:
 *   packages/extract/scripts/harness/start-legacy-tls.sh
 * (separate container/port from start.sh's normal harness — safe to run
 * alongside it). Excluded from `pnpm test`; run explicitly with
 * `pnpm test:integration` (vitest.integration.config.ts).
 *
 * Why this harness needs more than `mssql-conf set network.tlsprotocols
 * 1.0`: the mcr.microsoft.com/mssql/server:2022-latest image's Ubuntu
 * 22.04 base ships a system-wide OpenSSL 3.x policy
 * (`/etc/ssl/openssl.cnf`: `CipherString = DEFAULT:@SECLEVEL=2`) that
 * refuses TLS below 1.2 regardless of what SQL Server itself is
 * configured to accept — confirmed by `openssl s_client -tls1` failing
 * with "no protocols available" run from INSIDE the container even
 * after the mssql-conf change. start-legacy-tls.sh additionally patches
 * that file's SECLEVEL down to 0 before restarting, which is what
 * actually lets sqlservr negotiate TLS 1.0. This OpenSSL-policy quirk is
 * specific to this Linux test image's TLS stack (OpenSSL/SChannel
 * differ) — GMS's real SQL Server 2008 boxes run on Windows/SChannel,
 * unaffected by it; `allowLegacyTls`'s client-side logic is what this
 * test (and connection.test.ts's unit tests) actually prove, and that
 * logic is identical regardless of which TLS stack the server uses.
 */

const HOST = process.env.NIA_EXTRACT_MSSQL_LEGACY_TLS_HOST ?? "localhost";
const PORT = Number(process.env.NIA_EXTRACT_MSSQL_LEGACY_TLS_PORT ?? "14331");
const USER = process.env.NIA_EXTRACT_MSSQL_LEGACY_TLS_USER ?? "sa";
const PASSWORD = process.env.NIA_EXTRACT_MSSQL_LEGACY_TLS_PASSWORD ?? "N!aExtractLegacyTlsTest_2026";
const DATABASE = process.env.NIA_EXTRACT_MSSQL_LEGACY_TLS_DATABASE ?? "master";

describe("mssql legacy TLS (throwaway harness, TLS 1.0-only server)", () => {
  it("allowLegacyTls: true completes a real TLS 1.0 handshake and runs a query", async () => {
    const pool = await connect({
      server: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD,
      trustServerCertificate: true,
      allowLegacyTls: true,
      connectTimeoutMs: 8000,
    });
    try {
      const result = await pool.request().query<{ ok: number }>("SELECT 1 AS ok");
      expect(result.recordset[0]?.ok).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it("without allowLegacyTls, the same TLS-1.0-only server fails the handshake clearly (not a hang, not a generic timeout)", async () => {
    await expect(
      connect({
        server: HOST,
        port: PORT,
        database: DATABASE,
        user: USER,
        password: PASSWORD,
        trustServerCertificate: true,
        allowLegacyTls: false,
        connectTimeoutMs: 8000,
      }),
    ).rejects.toThrow(/unsupported protocol|SSL routines|socket hang up/i);
  });
});
