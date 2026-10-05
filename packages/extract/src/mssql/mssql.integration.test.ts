import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sql from "mssql";
import { connect, introspectCatalog, streamExtract } from "./index.js";
import { NdjsonWriter } from "../ndjsonWriter.js";
import { UnknownColumnError, UnknownTableError } from "../catalog.js";
import { UnknownOperatorError } from "../filterBuilder.js";
import type { Catalog, ExtractRequest, FilterCondition } from "../types.js";

/**
 * Mandatory Phase 1 integration tests (docs/plans/planometry-integration.md)
 * against a real SQL Server instance — none of these can be meaningfully
 * proven against a mock. Requires the throwaway harness running first:
 *   packages/extract/scripts/harness/start.sh
 * Excluded from `pnpm test` (vitest.config.ts); run explicitly with
 * `pnpm test:integration` (vitest.integration.config.ts).
 */

const HOST = process.env.NIA_EXTRACT_MSSQL_HOST ?? "localhost";
const PORT = Number(process.env.NIA_EXTRACT_MSSQL_PORT ?? "14330");
const USER = process.env.NIA_EXTRACT_MSSQL_USER ?? "sa";
const PASSWORD = process.env.NIA_EXTRACT_MSSQL_PASSWORD ?? "N!aExtractTest_2026";
const DATABASE = process.env.NIA_EXTRACT_MSSQL_DATABASE ?? "nia_extract_test";

interface ParsedStream {
  columns: { name: string; type: string }[] | undefined;
  rows: unknown[][];
  keepAlives: number;
  trailer: { end: true; rows: number } | { error: string } | undefined;
}

/** Parses the full NDJSON wire protocol (docs/plans/planometry-integration.md "Rows") back out of the raw chunks an NdjsonWriter emitted. */
function parseChunks(chunks: string[]): ParsedStream {
  const lines = chunks.join("").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const result: ParsedStream = { columns: undefined, rows: [], keepAlives: 0, trailer: undefined };
  for (const line of lines) {
    if (line === "") {
      result.keepAlives++;
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) {
      result.rows.push(parsed);
    } else if (parsed && typeof parsed === "object" && "columns" in parsed) {
      result.columns = (parsed as { columns: { name: string; type: string }[] }).columns;
    } else {
      result.trailer = parsed as { end: true; rows: number } | { error: string };
    }
  }
  return result;
}

async function runExtract(
  pool: sql.ConnectionPool,
  catalog: Catalog,
  request: ExtractRequest,
  options: { signal?: AbortSignal; keepAliveIntervalMs?: number } = {},
): Promise<ParsedStream> {
  const chunks: string[] = [];
  const writer = new NdjsonWriter((chunk) => {
    chunks.push(chunk);
  }, options.keepAliveIntervalMs);
  await streamExtract(pool, catalog, request, writer, { signal: options.signal });
  return parseChunks(chunks);
}

/** True if a request whose submitted batch text contains `textFragment` is currently executing (sys.dm_exec_requests), excluding the caller's own session. */
async function queryTextRunning(pool: sql.ConnectionPool, textFragment: string): Promise<boolean> {
  const result = await pool
    .request()
    .input("frag", `%${textFragment}%`)
    .query<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM sys.dm_exec_requests r
       CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE t.text LIKE @frag AND r.session_id <> @@SPID`,
    );
  return (result.recordset[0]?.c ?? 0) > 0;
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe("mssql integration (throwaway harness)", () => {
  let pool: sql.ConnectionPool;
  let catalog: Catalog;

  beforeAll(async () => {
    pool = await connect({
      server: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD,
      encrypt: true,
      trustServerCertificate: true,
    });
    catalog = await introspectCatalog(pool, "UTC");
  });

  afterAll(async () => {
    await pool.close();
  });

  describe("catalog", () => {
    it("lists tables/views across schemas, excluding unsupported native types with a reason", () => {
      const byName = new Map(catalog.tables.map((t) => [t.name, t]));
      expect(byName.get("dbo.widgets")?.kind).toBe("table");
      expect(byName.get("reporting.sales")?.kind).toBe("table");
      expect(byName.get("dbo.vw_slow")?.kind).toBe("view");
      expect(byName.get("dbo.big_table")?.kind).toBe("table");

      const excludedProbe = byName.get("dbo.excluded_probe");
      expect(excludedProbe).toBeDefined();
      const excludedNames = excludedProbe!.excluded.map((c) => c.name).sort();
      expect(excludedNames).toEqual(["blob", "geo", "geom", "legacy_blob", "tree", "variant"]);
      for (const col of excludedProbe!.excluded) expect(col.reason.length).toBeGreaterThan(0);
      expect(excludedProbe!.columns.map((c) => c.name)).toContain("allowed_text");
    });
  });

  describe("hostile identifiers and values", () => {
    it("round-trips a hostile bracket-containing column name exactly", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "weird]bracket"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("bracket]value");
      expect(byName.get("beta")).toBeNull();
    });

    it("rejects an unknown table before any SQL executes", async () => {
      await expect(streamExtract(pool, catalog, { table: "dbo.not_a_real_table", columns: [], filter: [] }, new NdjsonWriter(() => {}))).rejects.toThrow(UnknownTableError);
    });

    it("rejects an unknown column before any SQL executes", async () => {
      await expect(streamExtract(pool, catalog, { table: "dbo.widgets", columns: ["not_a_real_column"], filter: [] }, new NdjsonWriter(() => {}))).rejects.toThrow(UnknownColumnError);
    });

    it("rejects an unknown filter operator before any SQL executes", async () => {
      const filter = [{ column: "name", operator: "bogus", value: "x" }] as unknown as FilterCondition[];
      await expect(streamExtract(pool, catalog, { table: "dbo.widgets", columns: [], filter }, new NdjsonWriter(() => {}))).rejects.toThrow(UnknownOperatorError);
    });

    it("binds a hostile filter value as a parameter — no match, no injection, table stays intact", async () => {
      const { rows } = await runExtract(pool, catalog, {
        table: "dbo.widgets",
        columns: ["id"],
        filter: [{ column: "name", operator: "eq", value: "'; DROP TABLE dbo.widgets; --" }],
      });
      expect(rows).toHaveLength(0);
      const count = await pool.request().query<{ c: number }>("SELECT COUNT(*) AS c FROM dbo.widgets");
      expect(count.recordset[0]?.c).toBe(3);
    });
  });

  describe("every filter operator (dbo.widgets)", () => {
    it("eq / neq", async () => {
      const eq = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "name", operator: "eq", value: "alpha" }] });
      expect(eq.rows.map((r) => r[0])).toEqual(["alpha"]);

      const neq = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "name", operator: "neq", value: "alpha" }] });
      expect(neq.rows.map((r) => r[0]).sort()).toEqual(["beta", "disc%ount_promo"]);
    });

    it("gt / gte / lt / lte", async () => {
      const gt = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "price", operator: "gt", value: 10 }] });
      expect(gt.rows.map((r) => r[0])).toEqual(["alpha"]);

      const gte = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "price", operator: "gte", value: "5.00" }] });
      expect(gte.rows.map((r) => r[0]).sort()).toEqual(["alpha", "disc%ount_promo"]);

      const lt = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "price", operator: "lt", value: "5.00" }] });
      expect(lt.rows.map((r) => r[0])).toEqual(["beta"]);

      const lte = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "price", operator: "lte", value: "5.00" }] });
      expect(lte.rows.map((r) => r[0]).sort()).toEqual(["beta", "disc%ount_promo"]);
    });

    it("between", async () => {
      const { rows } = await runExtract(pool, catalog, {
        table: "dbo.widgets",
        columns: ["name"],
        filter: [{ column: "big", operator: "between", low: "-9223372036854775808", high: "0" }],
      });
      expect(rows.map((r) => r[0]).sort()).toEqual(["beta", "disc%ount_promo"]);
    });

    it("in", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "name", operator: "in", values: ["alpha", "beta"] }] });
      expect(rows.map((r) => r[0]).sort()).toEqual(["alpha", "beta"]);
    });

    it("startsWith escapes literal % and _ so they can't act as LIKE wildcards", async () => {
      const literalPercent = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "name", operator: "startsWith", value: "disc%" }] });
      expect(literalPercent.rows.map((r) => r[0])).toEqual(["disc%ount_promo"]);

      // "disc_" as a literal prefix must NOT match "disc%ount_promo" (5th
      // char is "%", not any single char) — proves "_" is escaped, not a
      // live wildcard.
      const literalUnderscore = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "name", operator: "startsWith", value: "disc_" }] });
      expect(literalUnderscore.rows).toHaveLength(0);
    });

    it("isNull / isNotNull", async () => {
      const isNull = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "notes", operator: "isNull" }] });
      expect(isNull.rows.map((r) => r[0])).toEqual(["beta"]);

      const isNotNull = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name"], filter: [{ column: "notes", operator: "isNotNull" }] });
      expect(isNotNull.rows.map((r) => r[0]).sort()).toEqual(["alpha", "disc%ount_promo"]);
    });
  });

  describe("exact values (dbo.widgets)", () => {
    it("decimal(38,10) round-trips every digit, never via float", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "exact_decimal"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("1234567890123456789012345678.1234567890");
      expect(byName.get("beta")).toBe("0.0000000000");
      expect(byName.get("disc%ount_promo")).toBe("0.0000000001");
    });

    it("money preserves its real 4-decimal precision (a plain CAST would truncate to 2)", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "cash"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("1234567890.1234");
      expect(byName.get("beta")).toBe("0.0000");
      expect(byName.get("disc%ount_promo")).toBe("0.0001");
    });

    it("bigint round-trips values beyond Number.MAX_SAFE_INTEGER exactly, including both extremes", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "big"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("9223372036854775807");
      expect(byName.get("beta")).toBe("0");
      expect(byName.get("disc%ount_promo")).toBe("-9223372036854775808");
    });

    it("datetime2(7) preserves 100ns fractional precision as UTC", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "created_at"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("2024-03-01T10:30:00.1234567Z");
    });

    it("datetimeoffset converts its own embedded offset to UTC, ignoring sourceTimeZone", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "created_at_offset"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("2024-03-01T05:00:00.1234567Z");
      expect(byName.get("disc%ount_promo")).toBe("2024-07-04T20:00:00.0000001Z");
    });

    it("time(7) passes through verbatim as text", async () => {
      const { rows } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["name", "duration"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], r[1]]));
      expect(byName.get("alpha")).toBe("13:45:30.1234567");
      expect(byName.get("disc%ount_promo")).toBe("23:59:59.9999999");
    });

    it("naive datetime/smalldatetime with no zone info converts using a non-UTC sourceTimeZone, respecting DST", async () => {
      const chicagoCatalog: Catalog = { ...catalog, sourceTimeZone: "America/Chicago" };
      const { rows } = await runExtract(pool, chicagoCatalog, { table: "dbo.widgets", columns: ["name", "legacy_dt", "small_dt"], filter: [] });
      const byName = new Map(rows.map((r) => [r[0], [r[1], r[2]]]));
      // January: CST = UTC-6.
      expect(byName.get("beta")).toEqual(["2024-01-01T06:00:00.000Z", "2024-01-01T06:00:00.000Z"]);
      // July: CDT = UTC-5 (DST).
      expect(byName.get("disc%ount_promo")).toEqual(["2024-07-04T17:00:00.000Z", "2024-07-04T17:00:00.000Z"]);
    });
  });

  describe("dbo.vw_slow (deliberately slow first row — see seed.sql's header comment: WAITFOR DELAY isn't legal inside a view, so this does genuine CPU-bound work instead)", () => {
    it("emits keep-alives while waiting, then streams the single row correctly", async () => {
      const { rows, trailer, keepAlives } = await runExtract(pool, catalog, { table: "dbo.vw_slow", columns: [], filter: [] }, { keepAliveIntervalMs: 500 });
      expect(keepAlives).toBeGreaterThan(0);
      expect(rows).toHaveLength(1);
      expect(trailer).toEqual({ end: true, rows: 1 });
    });

    it("aborting mid-stream cancels the query server-side (disappears from sys.dm_exec_requests) within a few seconds", async () => {
      const controller = new AbortController();
      const chunks: string[] = [];
      const writer = new NdjsonWriter((chunk) => {
        chunks.push(chunk);
      }, 500);

      const streamPromise = streamExtract(pool, catalog, { table: "dbo.vw_slow", columns: [], filter: [] }, writer, { signal: controller.signal });

      const started = await waitUntil(() => queryTextRunning(pool, "vw_slow"), 10_000);
      expect(started).toBe(true);

      controller.abort();
      await streamPromise; // streamExtract never throws for a query-time/abort failure — it resolves after writing {"error":"aborted"}.

      const stopped = await waitUntil(async () => !(await queryTextRunning(pool, "vw_slow")), 5_000);
      expect(stopped).toBe(true);

      expect(chunks.join("")).toContain('"error":"aborted"');
    });
  });

  describe("streamExtract request timeout (regression — E1 realtime stall)", () => {
    it("completes a scan blocked (lock wait, zero rows yet) for longer than the old 15000ms default, once the blocker releases", async () => {
      // Reproduces the real root cause: mssql/tedious's requestTimeout is a
      // time-to-first-byte timer, not a total-duration cap (cleared on the
      // first response packet — see streamExtract.ts's comment). A
      // concurrent writer holding a lock makes the reader's first row wait
      // past that timer with zero bytes received. Before the fix
      // (streamExtract.ts not passing `{ requestTimeout: 0 }`), this test
      // throws "Timeout: Request failed to complete in 15000ms" at ~15s,
      // before the blocker ever releases its lock.
      // Selecting `name` (not just the clustered PK `id`) matters: a scan
      // that reads only the clustering key does not block on another
      // session's X lock on that key, but reading a non-key column forces
      // SQL Server to touch the locked row and wait, which is what actually
      // happens for every real column list the agent extracts.
      const HOLD_MS = 16_000; // longer than the old 15000ms default
      const tx = new sql.Transaction(pool);
      await tx.begin();
      await new sql.Request(tx).query("UPDATE dbo.widgets SET name = name WHERE id = 1");

      const releaseTimer = setTimeout(() => {
        tx.commit().catch(() => {});
      }, HOLD_MS);

      try {
        const started = Date.now();
        const { rows, trailer } = await runExtract(pool, catalog, { table: "dbo.widgets", columns: ["id", "name"], filter: [] });
        expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS);
        expect(rows).toHaveLength(3);
        expect(trailer).toEqual({ end: true, rows: 3 });
      } finally {
        clearTimeout(releaseTimer);
        await tx.commit().catch(() => tx.rollback().catch(() => {}));
      }
    }, 30_000);
  });

  describe("dbo.big_table (1.2M rows)", () => {
    it("streams every row without buffering the result set in memory", async () => {
      let rowChunks = 0;
      let lastChunk = "";
      const samples: number[] = [];
      const sampleEvery = 150_000;
      const writer = new NdjsonWriter((chunk) => {
        lastChunk = chunk;
        if (chunk.length > 1 && chunk[0] === "[") {
          rowChunks++;
          if (rowChunks % sampleEvery === 0) samples.push(process.memoryUsage().heapUsed);
        }
      });

      const before = process.memoryUsage().heapUsed;
      await streamExtract(pool, catalog, { table: "dbo.big_table", columns: ["id"], filter: [] }, writer);
      const after = process.memoryUsage().heapUsed;

      expect(rowChunks).toBe(1_200_000);
      expect(lastChunk).toContain('"end":true');
      expect(lastChunk).toContain('"rows":1200000');

      // A genuinely streamed (never-buffered) 1.2M-row pass shouldn't grow
      // the heap anywhere near what buffering every row into one
      // in-memory array/string would cost. Generous bound to avoid
      // GC-timing flakiness while still catching a real "accumulate
      // everything" regression.
      const allSamples = [before, ...samples, after];
      const growth = Math.max(...allSamples) - Math.min(...allSamples);
      expect(growth).toBeLessThan(250 * 1024 * 1024);
    });
  });
});
