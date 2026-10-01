import { defineConfig } from "vitest/config";

// Integration config: mssql.integration.test.ts deliberately exercises a
// real SQL Server instance instead of mocking it — it proves memory-flat
// 1M+ row streaming, real mid-stream cancellation via sys.dm_exec_requests,
// keep-alives against a genuinely slow first row, and exact-value
// round-tripping (decimal(38,10)/money/bigint/datetime2(7)/datetimeoffset/
// time/non-UTC sourceTimeZone) against a real server's wire format — none
// of which a mock can meaningfully stand in for. Needs the throwaway
// harness running first: `packages/extract/scripts/harness/start.sh`.
// legacyTls.integration.test.ts similarly proves allowLegacyTls against a
// real TLS 1.0-only server; needs its own separate harness instead:
// `packages/extract/scripts/harness/start-legacy-tls.sh`.
// Kept out of the default `pnpm test` (vitest.config.ts) run so a failing
// unit suite always means a real regression, not "the harness wasn't up."
// Run explicitly with `pnpm test:integration`.
export default defineConfig({
  test: {
    include: ["src/mssql/mssql.integration.test.ts", "src/mssql/legacyTls.integration.test.ts"],
    // dbo.vw_slow's ~4M-row CPU-bound aggregation and dbo.big_table's
    // 1.2M-row streaming pass can both be slow under the throwaway
    // container's QEMU amd64 emulation (this is an arm64 host) — generous
    // timeouts to avoid flaking on that, not on a real regression.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
