/**
 * `upsertDelta` watermark strategy (docs/plans/planometry-v4-migration.md
 * §1.1, overridden by the task's own formula — see this file's header and
 * the plan doc's updated §1.1): reads the source SQL Server's own clock,
 * computes the next saved watermark, and reports the `job test`/`job add`
 * validation checks (null-watermark row count, clock-skew warning).
 *
 * Every watermark value here (`S`, `M`, the saved/returned watermark) is
 * the SAME fixed-width, no-offset wall-clock string family
 * `packages/extract`'s `valueSerializer.ts` already produces for an
 * extracted datetime/datetime2/smalldatetime value:
 * `${y}-${mo}-${d}T${h}:${mi}:${se}.${frac}` (always 3-digit milliseconds
 * here, since `SYSDATETIME()`'s own text form carries at most 3 — see
 * `readServerClock`). Treated as naive wall-clock text throughout — never
 * zone-interpreted here, only parsed into milliseconds for ordering and
 * arithmetic, then reformatted back into the same text family so it is
 * directly usable as a `gte` filter parameter (plan §1.1/§2) without a
 * new value format.
 */
import { createHash } from "node:crypto";
import { connect, quoteIdent, quoteQualifiedName } from "@nia/extract/mssql";
import type { SyncJobEntry } from "../config/types.js";

/** No direct `mssql` dependency in this package — same `Awaited<ReturnType<typeof connect>>` pattern `cli/jobCommands.ts`/`cli/runJobCommand.ts` already use to type a live pool. */
type ConnectionPool = Awaited<ReturnType<typeof connect>>;

export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatermarkError";
  }
}

const MS_PER_SECOND = 1000;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{1,9})$/;

/** Parses the fixed-width wall-clock string family into epoch milliseconds — purely for arithmetic/ordering (the digits are read as if they were UTC; they are never a real zone-aware instant, matching the "never shifted" contract the same string family carries everywhere else in this codebase). */
function parseWallClockMs(value: string): number {
  const m = WALL_CLOCK_RE.exec(value);
  if (!m) throw new WatermarkError(`not a recognized wall-clock watermark value: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, se, frac] = m;
  const ms = Number((frac ?? "0").padEnd(3, "0").slice(0, 3));
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se), ms);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Inverse of `parseWallClockMs` — always emits 3-digit milliseconds (matching `readServerClock`'s own precision). */
function formatWallClockMs(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Reads the source server's own clock, on the same connection (never the
 * agent's own `Date.now()`). `CONVERT(..., 121)` is the same SQL2008-safe,
 * ODBC-canonical style `buildSelectSql.ts` already uses for every naive
 * datetime-family column — its text form is space-separated
 * ("yyyy-mm-dd hh:mi:ss.mmm"); reformatted here to the 'T'-separated wall-
 * clock family for direct lexicographic comparability with extracted
 * watermark values.
 */
export async function readServerClock(pool: ConnectionPool): Promise<string> {
  const result = await pool.request().query<{ now: string }>("SELECT CONVERT(VARCHAR(23), SYSDATETIME(), 121) AS now");
  const raw = result.recordset[0]?.now;
  if (!raw) throw new WatermarkError("the server clock query (SELECT CONVERT(VARCHAR(23), SYSDATETIME(), 121)) returned no row");
  return raw.replace(" ", "T");
}

export interface ComputeNextWatermarkInput {
  /** M: the largest non-null watermark value seen among the extracted rows. Undefined when no row had one (including zero rows extracted). */
  maxSeen?: string;
  /** S: the source server's own clock, read at the start of this run's extraction. */
  serverClockAtStart: string;
  /** d: wall-clock duration of this run's extraction. */
  extractionDurationMs: number;
  overlapSeconds: number;
  /** True for a replace run (first run, forced replace, or any run with no prior saved watermark) — only this case may compute a fresh watermark when `maxSeen` is undefined. */
  isReplace: boolean;
}

/**
 * `min(M, S) - max(overlapSeconds, durationSeconds + 60)` (task item 3 —
 * this is a deliberate override of the plan doc's original, simpler
 * `S - overlapSeconds` formula; the plan doc is updated to match in this
 * same slice). Returns `undefined` ("leave the saved watermark
 * unchanged") when `maxSeen` is undefined and this is not a replace — a
 * delta run that saw no watermarked row at all must not advance (or
 * regress) whatever was already saved. When `maxSeen` is undefined AND
 * `isReplace` is true (e.g. an empty table, or every row had a null
 * watermark), the new watermark is `S - overlapSeconds` (no duration/60s
 * floor — there is no observed row to be cautious about racing).
 */
export function computeNextWatermark(input: ComputeNextWatermarkInput): string | undefined {
  const serverClockMs = parseWallClockMs(input.serverClockAtStart);

  if (input.maxSeen === undefined) {
    if (!input.isReplace) return undefined;
    return formatWallClockMs(serverClockMs - input.overlapSeconds * MS_PER_SECOND);
  }

  const maxSeenMs = parseWallClockMs(input.maxSeen);
  const minMs = Math.min(maxSeenMs, serverClockMs);
  const durationSeconds = input.extractionDurationMs / MS_PER_SECOND;
  const backoffSeconds = Math.max(input.overlapSeconds, durationSeconds + 60);
  return formatWallClockMs(minMs - backoffSeconds * MS_PER_SECOND);
}

export interface WatermarkColumnReport {
  /** `COUNT(*) WHERE watermarkColumn IS NULL` — reported, never silently skipped (plan §1.1). */
  nullCount: number;
  /** `MAX(watermarkColumn)`, in the same wall-clock string family — undefined if every row's value is null or the table is empty. */
  maxValue?: string;
  /** The server's own clock, read in the same connection as the two checks above. */
  serverClock: string;
  /** True when `maxValue` is strictly ahead of `serverClock` — usually means the column is populated by application-server time, not database time (plan §1.1). */
  aheadOfServerClock: boolean;
}

/** `job add`/`job test` validation (plan §1.1/§8): null-watermark-row count and the clock-skew check, both read in one connection alongside the server's own clock. */
export async function checkWatermarkColumn(pool: ConnectionPool, tableName: string, columnName: string): Promise<WatermarkColumnReport> {
  const qualified = quoteQualifiedName(tableName);
  const quotedColumn = quoteIdent(columnName);

  const serverClock = await readServerClock(pool);

  const nullResult = await pool
    .request()
    .query<{ nullCount: number }>(`SELECT COUNT(*) AS nullCount FROM ${qualified} WHERE ${quotedColumn} IS NULL`);
  const nullCount = nullResult.recordset[0]?.nullCount ?? 0;

  const maxResult = await pool
    .request()
    .query<{ maxValue: string | null }>(`SELECT CONVERT(VARCHAR(23), MAX(${quotedColumn}), 121) AS maxValue FROM ${qualified}`);
  const rawMax = maxResult.recordset[0]?.maxValue ?? null;
  const maxValue = rawMax ? rawMax.replace(" ", "T") : undefined;

  const aheadOfServerClock = maxValue !== undefined && parseWallClockMs(maxValue) > parseWallClockMs(serverClock);

  return { nullCount, maxValue, serverClock, aheadOfServerClock };
}

/**
 * The job's "delta definition" — the pieces of an `upsertDelta` job that a
 * saved watermark is only valid against (task item 1 — the fingerprint
 * rule): source table, filter, saved parameters, mapping, watermark
 * column, target URL. A saved watermark computed against one fingerprint
 * must never be reused once any of these changes — `cli/runJobCommand.ts`
 * computes this fresh on every run and compares it against the
 * fingerprint stored alongside the saved watermark (`ops/state.ts`'s
 * `lastWatermarkFingerprint`) before trusting it. `job update` no longer
 * needs to clear the saved watermark itself; a changed fingerprint makes
 * the stale watermark naturally unusable on the next run.
 */
export function computeJobFingerprint(job: Pick<SyncJobEntry, "sourceTable" | "filter" | "params" | "mapping" | "watermarkColumn" | "targetUrl">): string {
  const canonical = {
    sourceTable: job.sourceTable,
    filter: job.filter,
    params: job.params,
    // Mapping order doesn't change the job's semantics — sorted by target for a stable hash.
    mapping: [...job.mapping].map((m) => ({ source: m.source, target: m.target })).sort((a, b) => a.target.localeCompare(b.target)),
    watermarkColumn: job.watermarkColumn,
    targetUrl: job.targetUrl,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface SavedWatermarkState {
  /** `ops/state.ts`'s `getLastWatermark()` — undefined means no watermark has ever been saved. */
  watermark?: string;
  /** `ops/state.ts`'s `getLastWatermarkFingerprint()` — the fingerprint the watermark above was computed against. */
  fingerprint?: string;
}

/**
 * The fingerprint rule itself (task item 1): a saved watermark is usable
 * only when its saved fingerprint matches the job's current one —
 * otherwise it is treated as absent, same as a job's first run, which
 * (per `sync/runSync.ts`'s pushMode resolution) makes the next run a
 * replace.
 */
export function resolveSavedWatermark(saved: SavedWatermarkState, currentFingerprint: string): string | undefined {
  if (saved.watermark === undefined) return undefined;
  return saved.fingerprint === currentFingerprint ? saved.watermark : undefined;
}
