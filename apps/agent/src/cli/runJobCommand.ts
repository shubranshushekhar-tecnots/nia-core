import type { ExtractType, FilterCondition, FilterScalar } from "@nia/extract";
import { NdjsonWriter } from "@nia/extract";
import { connect, introspectCatalog, streamExtract } from "@nia/extract/mssql";
import { defaultHomeDir, defaultLogDir } from "../config/paths.js";
import { findConnection, findJob, loadConfig } from "../config/store.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { Logger } from "../ops/logger.js";
import { getLastWatermark, getLastWatermarkFingerprint } from "../ops/state.js";
import { resolveJobFilter } from "../planometry/parameters.js";
import { KeyedSemaphore } from "../sync/concurrency.js";
import { runSync, type RunSyncFailureKind, type RunSyncResult } from "../sync/runSync.js";
import { computeJobFingerprint, readServerClock, resolveSavedWatermark } from "../sync/watermark.js";

/** One process-wide semaphore (per target table URL) — a second concurrent `job run` in the same process is queued, not just refused cross-process (sync/replaceLock.ts handles that). */
const tableSemaphore = new KeyedSemaphore(1);

export interface RunJobOptions {
  /**
   * `job run --replace`: for a `replace`-strategy job this is a no-op
   * (it's already the only thing that ever happens). For an
   * `upsertDelta` job it forces a one-off full reload — same as a
   * first run with no saved watermark — without clearing the saved
   * watermark itself (docs/plans/planometry-v4-migration.md §10
   * slice C1).
   */
  replace?: boolean;
  signal?: AbortSignal;
  /**
   * `job run --param`: overrides the job's saved params for this run
   * only, never persisted. For an `upsertDelta` job this also forces
   * an upsert-mode run scoped to the override filter that never reads
   * or writes the saved watermark — a narrow ad-hoc query must never
   * replace-wipe the whole target table, and its result says nothing
   * about the job's normal delta progress.
   */
  paramOverrides?: Record<string, string>;
  /** `job run --allow-mass-delete`: lets one run through key reconciliation's mass-delete guard (§1.2/§10, slice D1). */
  allowMassDelete?: boolean;
}

export interface RunJobOutcome {
  ok: boolean;
  summary?: string;
  /** Present on every success — lets the scheduler record rows/duration without parsing `summary`. */
  rowsSent?: number;
  durationMs?: number;
  /** Safe to log — never a raw server message. */
  error?: string;
  /** A 400's raw server message, console-only — never pass this to a logger. */
  consoleMessage?: string;
  /**
   * Present on every failure — lets the scheduler (scheduler/jobScheduler.ts)
   * decide pause vs. retry-with-backoff vs. wait-for-next-schedule. Most
   * pre-runSync failures (missing job/connection/secrets, filter
   * resolution) are reported as "other": they're not among the
   * pause-triggering causes in §10(B2) item 3, and retrying them
   * immediately can't help, so the job simply waits for its next tick.
   * A missing source table or column is reported as "config" instead —
   * it's a schema stop just like a Planometry-side schema mismatch, not
   * a transient condition that retrying (or silently waiting for the
   * next tick forever) could ever resolve on its own; it needs `job
   * resume` after the schema problem is actually fixed.
   */
  kind?: RunSyncFailureKind;
}

/**
 * `nia-agent job run <id>`: resolves the job + connection + secrets,
 * introspects the live source catalog for the mapped columns' types,
 * and drives `runSync` with a `readSourceRows` adapter built from
 * `@nia/extract`'s existing `streamExtract`/`NdjsonWriter` pair — the
 * same extraction path the old work-queue agent used, reused here as a
 * synchronous push rather than a wire protocol since both ends are this
 * one process.
 */
export async function runJob(id: string, options: RunJobOptions = {}, dir = defaultHomeDir()): Promise<RunJobOutcome> {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return { ok: false, error: `no job with id ${JSON.stringify(id)}`, kind: "other" };
  const connection = findConnection(config, job.connectionId);
  if (!connection) return { ok: false, error: `no connection with id ${JSON.stringify(job.connectionId)}`, kind: "other" };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef);
  if (!pushKeySecret) return { ok: false, error: `push key for job ${id} is missing from the secret store`, kind: "other" };
  const credentials = secrets.get<{ user: string; password: string }>(connection.credentialRef);
  if (!credentials) return { ok: false, error: `credentials for connection ${connection.id} are missing from the secret store`, kind: "other" };

  const logger = new Logger(defaultLogDir(dir));

  let pool: Awaited<ReturnType<typeof connect>>;
  try {
    pool = await connect({
      server: connection.sqlserver.host,
      port: connection.sqlserver.port,
      database: connection.sqlserver.database,
      user: credentials.user,
      password: credentials.password,
      encrypt: connection.sqlserver.encrypt,
      allowLegacyTls: connection.sqlserver.allowLegacyTls,
      trustServerCertificate: connection.sqlserver.trustServerCertificate,
    });
  } catch (err) {
    // SQL connection failure — §10(B2) item 2: retry at 1/5/15 min, never pause.
    return { ok: false, error: err instanceof Error ? err.message : String(err), kind: "transient" };
  }

  try {
    const catalog = await introspectCatalog(pool, connection.sourceTimeZone);
    const table = catalog.tables.find((t) => t.name === job.sourceTable);
    if (!table) return { ok: false, error: `source table/view "${job.sourceTable}" was not found in the catalog`, kind: "config" };

    const sourceColumnTypes: Record<string, ExtractType> = {};
    for (const pair of job.mapping) {
      const column = table.columns.find((c) => c.name === pair.source);
      if (!column) return { ok: false, error: `source column "${pair.source}" no longer exists in the catalog`, kind: "config" };
      sourceColumnTypes[pair.source] = column.type;
    }

    const mappedSources = job.mapping.map((m) => m.source);

    // Filter columns need not be mapped, so type-check against every catalog column, not just mappedSources.
    const catalogColumnTypes: Record<string, ExtractType> = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
    let resolvedFilter: ReturnType<typeof resolveJobFilter>;
    try {
      resolvedFilter = resolveJobFilter(job.filter, catalogColumnTypes, job.params, options.paramOverrides, connection.sourceTimeZone);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), kind: "other" };
    }
    if (Object.keys(resolvedFilter.resolvedParams).length > 0) {
      logger.info("job_run_params", { jobId: job.id, resolvedParams: JSON.stringify(resolvedFilter.resolvedParams) });
    }

    // One single-pass reader, reusable for a plain `readSourceRows` call
    // or composed into the two-pass `gte` + `isNull` delta read below —
    // each pass needs its own `NdjsonWriter` since a writer's `columns`/
    // `error` state is permanently closed out by `streamExtract`'s own
    // end-of-stream handling and can't be reused across two calls.
    const makeSinglePassReader = (
      columns: string[],
      filter: FilterCondition[],
    ): ((onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>) => {
      return async (onRow, signal) => {
        let resultColumns: { name: string; type: ExtractType }[] = [];
        let streamError: string | undefined;

        const writer = new NdjsonWriter((chunk) => {
          const text = chunk.trim();
          if (!text) return true; // keep-alive line
          const parsed = JSON.parse(text) as unknown;
          if (Array.isArray(parsed)) {
            const row: Record<string, unknown> = {};
            resultColumns.forEach((c, i) => {
              row[c.name] = parsed[i];
            });
            onRow(row);
            return true;
          }
          const obj = parsed as { columns?: typeof resultColumns; error?: string };
          if (obj.columns) {
            resultColumns = obj.columns;
            return true;
          }
          if (obj.error) {
            streamError = obj.error;
            return true;
          }
          return true; // the {"end":true,...} trailer — nothing to do
        });

        await streamExtract(pool, catalog, { table: job.sourceTable, columns, filter }, writer, { signal });
        if (streamError) throw new Error(streamError);
      };
    };

    const isUpsertDelta = job.strategy === "upsertDelta";
    const isParamOverride = isUpsertDelta && options.paramOverrides !== undefined;

    let passes: ((onRow: (row: Record<string, unknown>) => void, signal: AbortSignal) => Promise<void>)[];
    let delta: Parameters<typeof runSync>[0]["delta"];

    if (!isUpsertDelta) {
      passes = [makeSinglePassReader(mappedSources, resolvedFilter.filter)];
    } else {
      const watermarkColumn = job.watermarkColumn;
      if (!watermarkColumn) {
        return { ok: false, error: `job ${id} has strategy "upsertDelta" but no watermarkColumn configured`, kind: "config" };
      }
      if (!table.columns.some((c) => c.name === watermarkColumn)) {
        return { ok: false, error: `watermark column "${watermarkColumn}" no longer exists in the catalog`, kind: "config" };
      }

      const extractColumns = mappedSources.includes(watermarkColumn) ? mappedSources : [...mappedSources, watermarkColumn];
      const forceReplace = options.replace === true;
      // Fingerprint rule (task item 1): a saved watermark is only trusted
      // when it was computed against the job's current delta definition
      // (source table, filter, saved params, mapping, watermark column,
      // target URL) — a mismatch (including "never saved one") resolves
      // to undefined, same as a first run, which forces a replace below.
      const fingerprint = computeJobFingerprint(job);
      const savedWatermark = isParamOverride
        ? undefined
        : resolveSavedWatermark({ watermark: getLastWatermark(job.id, dir), fingerprint: getLastWatermarkFingerprint(job.id, dir) }, fingerprint);
      const serverClockAtStart = await readServerClock(pool);

      if (isParamOverride || forceReplace || savedWatermark === undefined) {
        passes = [makeSinglePassReader(extractColumns, resolvedFilter.filter)];
      } else {
        const gteFilter: FilterCondition[] = [...resolvedFilter.filter, { column: watermarkColumn, operator: "gte", value: savedWatermark }];
        const isNullFilter: FilterCondition[] = [...resolvedFilter.filter, { column: watermarkColumn, operator: "isNull" }];
        passes = [makeSinglePassReader(extractColumns, gteFilter), makeSinglePassReader(extractColumns, isNullFilter)];
      }

      delta = { watermarkColumn, overlapSeconds: job.overlapSeconds ?? 300, savedWatermark, forceReplace, isParamOverride, serverClockAtStart, fingerprint };
    }

    // Key reconciliation (§1.2/§10, slice D1): only for an upsertDelta job
    // opted into it, and never for a `--param` override run (item 3 — "a
    // `--param` override run never reads or writes the list"). The scan
    // reads key source columns only, with the job's resolved filter, no
    // ORDER BY — same reader factory as every other pass.
    let reconciliation: Parameters<typeof runSync>[0]["reconciliation"];
    if (isUpsertDelta && job.deleteMode === "reconciliation" && !isParamOverride) {
      const keyTargets = job.targetSchemaSnapshot.keyColumns;
      const keySourceColumns = job.mapping.filter((m) => keyTargets.includes(m.target)).map((m) => m.source);
      reconciliation = {
        readKeyScanRows: makeSinglePassReader(keySourceColumns, resolvedFilter.filter),
        maxDeletePercent: job.maxDeletePercent ?? 20,
        allowMassDelete: options.allowMassDelete ?? false,
      };
    }

    const readSourceRows = async (onRow: (row: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> => {
      for (const pass of passes) {
        await pass(onRow, signal);
      }
    };

    const result = await runSync({
      job,
      pushKey: pushKeySecret.pushKey,
      sourceColumnTypes,
      sourceTimeZone: connection.sourceTimeZone,
      dir,
      masterKey,
      tableSemaphore,
      logger,
      signal: options.signal,
      readSourceRows,
      delta,
      reconciliation,
    });

    return outcomeFromResult(result, resolvedFilter.resolvedParams);
  } finally {
    await pool.close();
  }
}

function outcomeFromResult(result: RunSyncResult, resolvedParams: Record<string, FilterScalar>): RunJobOutcome {
  const paramsSuffix = Object.keys(resolvedParams).length > 0 ? ` — params: ${JSON.stringify(resolvedParams)}` : "";
  if (result.outcome === "completed") {
    // "replace" carries a whole-table rowCount/version from Planometry's response; "upsert" doesn't (see RunSyncResult's doc comment).
    const planometrySuffix =
      result.rowCount !== undefined || result.version !== undefined ? ` — Planometry rowCount ${result.rowCount}, version ${result.version}` : "";
    const watermarkSuffix =
      result.watermarkBefore !== undefined || result.watermarkAfter !== undefined
        ? ` — watermark ${result.watermarkBefore ?? "(none)"} -> ${result.watermarkAfter ?? "(none)"}`
        : "";
    const reconciliationSuffix = result.reconciliation
      ? ` — key reconciliation: ${result.reconciliation.deletesSent} delete(s) sent${
          result.reconciliation.duplicateKeyCount > 0 ? ` (WARNING: ${result.reconciliation.duplicateKeyCount} duplicate key(s) seen)` : ""
        }`
      : "";
    return {
      ok: true,
      summary: `${result.mode}: sent ${result.rowsSent} row(s) (${result.rowsSkipped} skipped) in ${result.parts} part(s), ${result.durationMs}ms${planometrySuffix}${watermarkSuffix}${reconciliationSuffix}${paramsSuffix}`,
      rowsSent: result.rowsSent,
      durationMs: result.durationMs,
    };
  }
  return { ok: false, error: result.error, consoleMessage: result.consoleMessage, kind: result.kind };
}
