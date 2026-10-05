import { randomUUID } from "node:crypto";
import type { CatalogTable, ExtractType } from "@nia/extract";
import { connect, introspectCatalog } from "@nia/extract/mssql";
import { defaultHomeDir } from "../config/paths.js";
import {
  findConnection,
  findJob,
  loadConfig,
  removeJob as removeFromConfig,
  saveConfig,
  upsertJob,
} from "../config/store.js";
import type {
  ConnectionEntry,
  DeleteMode,
  DestinationType,
  HttpsAuthMethod,
  JobMappingColumn,
  JobStrategy,
  OnNullKey,
  SyncJobEntry,
  TargetSchemaSnapshot,
} from "../config/types.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { PlanometryClient } from "../planometry/client.js";
import { isRelativeDateToken, resolveJobFilter, type FilterValueOrParam, type JobFilterCondition } from "../planometry/parameters.js";
import type { TableSchema } from "../planometry/types.js";
import { pauseJobState, resumeJobState } from "../ops/state.js";
import { InvalidCronScheduleError, validateCronExpression } from "../scheduler/cronSchedule.js";
import { removeKeyList } from "../sync/keyReconciliation.js";
import { checkWatermarkColumn, type WatermarkColumnReport } from "../sync/watermark.js";
import { validateHttpsAddress } from "../destinations/httpsAddress.js";
import { buildHttpsMapping, buildMapping, type RawMappingPair } from "./jobMapping.js";

const DEFAULT_MAX_DELETE_PERCENT = 20;
/** `strategy: "realtime"` only (§1.3/E1): tick interval default/minimum, seconds. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MIN_POLL_INTERVAL_SECONDS = 10;
/** `strategy: "realtime"` + `deleteMode: "reconciliation"` only (§1.3/E1): key-list comparison cadence default, seconds. */
const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 600;

/** `deleteMode: "softDelete"` only (§1.2/§10, slice D2): a non-fatal reminder returned via `JobCommandResult.warnings` — this mode only ever removes a row whose flag column is true; a row that instead simply leaves the job's filter (e.g. no longer matches a date range) is never removed by it. */
const SOFT_DELETE_FILTER_WARNING =
  'deleteMode "softDelete" only removes rows whose flag column is true — a row that leaves the job\'s filter for any other reason is not removed; add a replaceSchedule (periodic full replace) to also catch those.';

/**
 * `deleteMode` validation shared by `addJob`/`updateJob` (plan §1.2/§7/
 * §10, slices D1/D2/E1): any non-"none" mode requires `strategy ===
 * "upsertDelta"` or `"realtime"`. "reconciliation": `maxDeletePercent`
 * (if given) must be in (0, 100]. "softDelete": a `softDeleteColumn` is
 * required, must exist in the live source catalog, and must be a
 * boolean (SQL Server `bit`) column. Mirrors `validateUpsertDelta`'s
 * error style.
 */
function validateDeleteMode(
  strategy: JobStrategy,
  deleteMode: DeleteMode | undefined,
  maxDeletePercent: number | undefined,
  softDeleteColumn: string | undefined,
  table: CatalogTable,
): { ok: true } | { ok: false; error: string } {
  if (deleteMode === undefined || deleteMode === "none") return { ok: true };
  if (strategy !== "upsertDelta" && strategy !== "realtime") {
    return { ok: false, error: `deleteMode "${deleteMode}" requires strategy "upsertDelta" or "realtime"` };
  }
  if (deleteMode === "reconciliation") {
    if (maxDeletePercent !== undefined && !(maxDeletePercent > 0 && maxDeletePercent <= 100)) {
      return { ok: false, error: `maxDeletePercent must be greater than 0 and at most 100` };
    }
    return { ok: true };
  }
  // deleteMode === "softDelete"
  if (!softDeleteColumn) return { ok: false, error: `deleteMode "softDelete" requires a softDeleteColumn` };
  const column = table.columns.find((c) => c.name === softDeleteColumn);
  if (!column) return { ok: false, error: `soft-delete column "${softDeleteColumn}" was not found in the catalog` };
  if (column.type !== "boolean") return { ok: false, error: `soft-delete column "${softDeleteColumn}" is type ${column.type}, not boolean` };
  return { ok: true };
}

/** Opens a connection pool for `connection`, runs `fn`, and always closes it — the watermark-column check (needs a live connection, unlike the catalog-only `readSourceTable` below) is the one caller of this so far. */
async function withConnectedPool<T>(connection: ConnectionEntry, dir: string, fn: (pool: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(connection.credentialRef);
  if (!credentials) throw new Error(`credentials for connection ${connection.id} are missing from the secret store`);
  const pool = await connect({
    server: connection.sqlserver.host,
    port: connection.sqlserver.port,
    database: connection.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: connection.sqlserver.encrypt,
    allowLegacyTls: connection.sqlserver.allowLegacyTls,
    trustServerCertificate: connection.sqlserver.trustServerCertificate,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

/** Whether `filter` binds any parameter whose saved value (in `params`) is a relative-date token (`today`, `startOfMonth-1m`, etc.) — `upsertDelta` jobs with one of these require a `replaceSchedule` (plan §2). */
function filterUsesRelativeDateToken(filter: JobFilterCondition[], params: Record<string, string>): boolean {
  const isParamRef = (v: FilterValueOrParam): v is { param: string } => typeof v === "object" && v !== null && typeof (v as { param?: unknown }).param === "string";
  const checkValue = (v: FilterValueOrParam): boolean => {
    if (!isParamRef(v)) return false;
    const raw = params[v.param];
    return raw !== undefined && isRelativeDateToken(raw);
  };
  for (const cond of filter) {
    switch (cond.operator) {
      case "isNull":
      case "isNotNull":
        continue;
      case "in":
        if (cond.values.some(checkValue)) return true;
        continue;
      case "between":
        if (checkValue(cond.low) || checkValue(cond.high)) return true;
        continue;
      default:
        if (checkValue(cond.value)) return true;
    }
  }
  return false;
}

/**
 * `strategy: "upsertDelta"` or `"realtime"` validation shared by
 * `addJob`/`updateJob` (plan §1.1/§1.3/§2/§8/§10, slices C1/E1): the
 * watermark column must exist in the live source catalog and be a
 * datetime-family column; a relative-date filter parameter requires a
 * `replaceSchedule`; a given `replaceSchedule` must itself be a valid
 * cron expression. Returns the null-count/clock-skew report on
 * success, for the caller to attach to its result.
 */
async function validateUpsertDelta(
  strategy: "upsertDelta" | "realtime",
  connection: ConnectionEntry,
  table: CatalogTable,
  sourceTable: string,
  watermarkColumn: string | undefined,
  filter: JobFilterCondition[],
  params: Record<string, string>,
  replaceSchedule: string | undefined,
  dir: string,
): Promise<{ ok: true; report: WatermarkColumnReport } | { ok: false; error: string }> {
  if (!watermarkColumn) return { ok: false, error: `strategy "${strategy}" requires a watermarkColumn` };
  const column = table.columns.find((c) => c.name === watermarkColumn);
  if (!column) return { ok: false, error: `watermark column "${watermarkColumn}" was not found in the catalog` };
  if (column.type !== "datetime") return { ok: false, error: `watermark column "${watermarkColumn}" is type ${column.type}, not a datetime-family column` };

  if (filterUsesRelativeDateToken(filter, params) && replaceSchedule === undefined) {
    return { ok: false, error: `a filter using a relative-date token requires a replaceSchedule (periodic full replace) for a "${strategy}" job` };
  }
  if (replaceSchedule !== undefined) {
    try {
      validateCronExpression(replaceSchedule);
    } catch (err) {
      if (err instanceof InvalidCronScheduleError) return { ok: false, error: err.message };
      throw err;
    }
  }

  try {
    const report = await withConnectedPool(connection, dir, (pool) => checkWatermarkColumn(pool, sourceTable, watermarkColumn));
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `strategy: "realtime"` only (§1.3/E1): `pollIntervalSeconds` default
 * 60, minimum 10; `reconciliationIntervalSeconds` (only meaningful when
 * `deleteMode === "reconciliation"`) default 600.
 */
function validateRealtimeIntervals(
  pollIntervalSeconds: number | undefined,
  reconciliationIntervalSeconds: number | undefined,
  deleteMode: DeleteMode | undefined,
): { ok: true; pollIntervalSeconds: number; reconciliationIntervalSeconds: number | undefined } | { ok: false; error: string } {
  const poll = pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  if (poll < MIN_POLL_INTERVAL_SECONDS) return { ok: false, error: `pollIntervalSeconds must be at least ${MIN_POLL_INTERVAL_SECONDS}` };
  const reconcile = deleteMode === "reconciliation" ? reconciliationIntervalSeconds ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS : undefined;
  return { ok: true, pollIntervalSeconds: poll, reconciliationIntervalSeconds: reconcile };
}

/** `{ column name -> source ExtractType }`, for filter type-checking — filter columns need not be in the job's mapping. */
function columnTypesOf(table: CatalogTable): Record<string, ExtractType> {
  return Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
}

/** Printable preview of a job's mapping, shown before `job add`/`job update` save. */
export interface JobMappingPreview {
  pairs: JobMappingColumn[];
  sentAsNull: string[];
}

export interface JobCommandOptions {
  /** Called with the built mapping before saving — the CLI uses this to print it. */
  onPlan?: (plan: JobMappingPreview) => void;
  /** Returning false aborts without saving (declined confirmation). Defaults to true (e.g. `--yes`). */
  confirm?: (plan: JobMappingPreview) => boolean | Promise<boolean>;
}

export interface JobCommandResult {
  ok: boolean;
  job?: SyncJobEntry;
  sentAsNull?: string[];
  errors?: string[];
  /** `strategy: "upsertDelta"` only — the null-count/clock-skew report from `sync/watermark.ts`'s `checkWatermarkColumn`. */
  watermarkReport?: WatermarkColumnReport;
  /** Non-fatal advisories, e.g. `deleteMode: "softDelete"`'s filter-exclusion reminder (§1.2/§10, slice D2). */
  warnings?: string[];
}

/** `destinationType: "https"` only (slice R2) — the sign-in config + secret for `addJob`. The secret is the bearer token / API key value / basic password, absent for `authMethod: "none"`. */
export interface AddJobHttpsInput {
  authMethod: HttpsAuthMethod;
  headerName?: string;
  username?: string;
  secret?: string;
  rowsField?: string;
}

export interface AddJobInput {
  id?: string;
  name: string;
  connectionId: string;
  sourceTable: string;
  targetUrl: string;
  /** Required when `destinationType` is unset or `"planometry"`; unused for `"https"`. */
  pushKey?: string;
  mapOverrides: RawMappingPair[];
  /** Unset means `"planometry"` (back-compat). */
  destinationType?: DestinationType;
  /** `destinationType: "https"` only — required then. */
  https?: AddJobHttpsInput;
  /** §7: default "stop". */
  onNullKey?: OnNullKey;
  /** §7: default false. */
  allowEmptyReplace?: boolean;
  /** AND-joined; default none. */
  filter?: JobFilterCondition[];
  /** Saved named-parameter values; default none. */
  params?: Record<string, string>;
  /** 5-field cron expression, evaluated in the connection's sourceTimeZone (scheduler/cronSchedule.js). Unset = runs only via `job run`. */
  schedule?: string;
  /** Default "replace" (§10 slice C1/E1). */
  strategy?: JobStrategy;
  /** `strategy: "upsertDelta"` or `"realtime"` only — required then. */
  watermarkColumn?: string;
  /** `strategy: "upsertDelta"` or `"realtime"` only — default 300, applied where read. */
  overlapSeconds?: number;
  /** `strategy: "upsertDelta"` or `"realtime"` only — required when `filter` uses a relative-date token. */
  replaceSchedule?: string;
  /** `strategy: "upsertDelta"` or `"realtime"` only — default "none" (§10 slice D1/E1). */
  deleteMode?: DeleteMode;
  /** `deleteMode: "reconciliation"` only — default 20 when unset. */
  maxDeletePercent?: number;
  /** `deleteMode: "softDelete"` only — required then. */
  softDeleteColumn?: string;
  /** `strategy: "realtime"` only (§1.3/E1) — default 60, minimum 10. */
  pollIntervalSeconds?: number;
  /** `strategy: "realtime"` + `deleteMode: "reconciliation"` only (§1.3/E1) — default 600. */
  reconciliationIntervalSeconds?: number;
}

/**
 * `nia-agent job add`: reads the source catalog, checks the target via
 * `checkConnection`/`getSchema`, builds the mapping, and only writes the
 * push key + job entry once every validation step (and, interactively,
 * confirmation) has passed — any failure leaves no job and no secret
 * behind (docs/plans/planometry-v4-migration.md §10 slice A2).
 */
export async function addJob(input: AddJobInput, options: JobCommandOptions = {}, dir = defaultHomeDir()): Promise<JobCommandResult> {
  const config = loadConfig(dir);
  const connection = findConnection(config, input.connectionId);
  if (!connection) return { ok: false, errors: [`no connection with id ${JSON.stringify(input.connectionId)}`] };

  if (input.destinationType === "https") {
    // Checked before touching the source connection: a bad address is a
    // pure input-validation failure, and should fail fast without a live
    // SQL Server round trip (also what lets this be tested without a DB).
    const addressCheck = validateHttpsAddress(input.targetUrl);
    if (!addressCheck.ok) return { ok: false, errors: [addressCheck.error] };
  }

  const catalogResult = await readSourceTable(connection, input.sourceTable, dir);
  if (!catalogResult.ok) return { ok: false, errors: [catalogResult.error] };

  if (input.destinationType === "https") {
    return addHttpsJob(input, connection, catalogResult.table, options, dir, config);
  }

  if (!input.pushKey) return { ok: false, errors: ['pushKey is required for destinationType "planometry"'] };
  const client = new PlanometryClient({ tableUrl: input.targetUrl, pushKey: input.pushKey });
  let schema: TableSchema;
  try {
    await client.checkConnection();
    schema = await client.getSchema();
  } catch (err) {
    return { ok: false, errors: [describeError(err)] };
  } finally {
    await client.close();
  }

  const plan = buildMapping(catalogResult.table, schema.columns, schema.keyColumns, input.mapOverrides, connection.sourceTimeZone);
  if (plan.errors.length > 0) return { ok: false, errors: plan.errors };

  const filter = input.filter ?? [];
  const params = input.params ?? {};
  try {
    resolveJobFilter(filter, columnTypesOf(catalogResult.table), params, undefined, connection.sourceTimeZone);
  } catch (err) {
    return { ok: false, errors: [describeError(err)] };
  }

  if (input.schedule !== undefined) {
    try {
      validateCronExpression(input.schedule);
    } catch (err) {
      if (err instanceof InvalidCronScheduleError) return { ok: false, errors: [err.message] };
      throw err;
    }
  }

  const strategy: JobStrategy = input.strategy ?? "replace";
  let watermarkReport: WatermarkColumnReport | undefined;
  if (strategy === "upsertDelta" || strategy === "realtime") {
    const check = await validateUpsertDelta(
      strategy,
      connection,
      catalogResult.table,
      input.sourceTable,
      input.watermarkColumn,
      filter,
      params,
      input.replaceSchedule,
      dir,
    );
    if (!check.ok) return { ok: false, errors: [check.error] };
    watermarkReport = check.report;
  }

  const deleteModeCheck = validateDeleteMode(strategy, input.deleteMode, input.maxDeletePercent, input.softDeleteColumn, catalogResult.table);
  if (!deleteModeCheck.ok) return { ok: false, errors: [deleteModeCheck.error] };

  let realtimeIntervals: { pollIntervalSeconds: number; reconciliationIntervalSeconds: number | undefined } | undefined;
  if (strategy === "realtime") {
    const check = validateRealtimeIntervals(input.pollIntervalSeconds, input.reconciliationIntervalSeconds, input.deleteMode);
    if (!check.ok) return { ok: false, errors: [check.error] };
    realtimeIntervals = check;
  }

  const pairs: JobMappingColumn[] = plan.pairs;
  const preview: JobMappingPreview = { pairs, sentAsNull: plan.sentAsNull };
  options.onPlan?.(preview);
  const confirmed = await (options.confirm?.(preview) ?? true);
  if (!confirmed) return { ok: false, errors: ["aborted: not confirmed"] };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeyRef = secrets.put({ pushKey: input.pushKey });

  const job: SyncJobEntry = {
    id: input.id ?? randomUUID(),
    name: input.name,
    connectionId: input.connectionId,
    sourceTable: input.sourceTable,
    targetUrl: input.targetUrl,
    pushKeyRef,
    strategy,
    mapping: pairs,
    targetSchemaSnapshot: buildTargetSchemaSnapshot(schema, pairs),
    onNullKey: input.onNullKey ?? "stop",
    allowEmptyReplace: input.allowEmptyReplace ?? false,
    filter,
    params,
    schedule: input.schedule,
    watermarkColumn: strategy === "upsertDelta" || strategy === "realtime" ? input.watermarkColumn : undefined,
    overlapSeconds: strategy === "upsertDelta" || strategy === "realtime" ? input.overlapSeconds : undefined,
    replaceSchedule: strategy === "upsertDelta" || strategy === "realtime" ? input.replaceSchedule : undefined,
    deleteMode: strategy === "upsertDelta" || strategy === "realtime" ? input.deleteMode : undefined,
    maxDeletePercent:
      (strategy === "upsertDelta" || strategy === "realtime") && input.deleteMode === "reconciliation"
        ? input.maxDeletePercent ?? DEFAULT_MAX_DELETE_PERCENT
        : undefined,
    softDeleteColumn:
      (strategy === "upsertDelta" || strategy === "realtime") && input.deleteMode === "softDelete" ? input.softDeleteColumn : undefined,
    pollIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.pollIntervalSeconds : undefined,
    reconciliationIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.reconciliationIntervalSeconds : undefined,
  };

  saveConfig(upsertJob(config, job), dir);
  const warnings = (strategy === "upsertDelta" || strategy === "realtime") && input.deleteMode === "softDelete" ? [SOFT_DELETE_FILTER_WARNING] : undefined;
  return { ok: true, job, sentAsNull: plan.sentAsNull, watermarkReport, warnings };
}

/**
 * `destinationType: "https"` branch of `addJob` (slice R2, task items 2/3).
 * There is no live target schema, so: mapping is explicit-only
 * (`buildHttpsMapping`), `targetSchemaSnapshot` is an empty placeholder,
 * and `strategy: "realtime"`/any `deleteMode` other than "none" are
 * refused outright (both are refused for this destination type by the
 * task spec). The sign-in secret (bearer token / API key value / basic
 * password) is stored via the job's existing `pushKeyRef`, reused rather
 * than adding a second secret-ref field; unset entirely for
 * `authMethod: "none"`.
 */
async function addHttpsJob(
  input: AddJobInput,
  connection: ConnectionEntry,
  table: CatalogTable,
  options: JobCommandOptions,
  dir: string,
  config: ReturnType<typeof loadConfig>,
): Promise<JobCommandResult> {
  const addressCheck = validateHttpsAddress(input.targetUrl);
  if (!addressCheck.ok) return { ok: false, errors: [addressCheck.error] };

  const strategy: JobStrategy = input.strategy ?? "replace";
  if (strategy === "realtime") return { ok: false, errors: ['destinationType "https" does not support strategy "realtime"'] };
  if (input.deleteMode !== undefined && input.deleteMode !== "none") {
    return { ok: false, errors: [`destinationType "https" does not support deleteMode "${input.deleteMode}"`] };
  }

  const https = input.https;
  if (!https) return { ok: false, errors: ['destinationType "https" requires an https config'] };
  if (https.authMethod === "apiKey" && !https.headerName) {
    return { ok: false, errors: ['https authMethod "apiKey" requires a headerName'] };
  }
  if (https.authMethod === "basic" && !https.username) {
    return { ok: false, errors: ['https authMethod "basic" requires a username'] };
  }
  if (https.authMethod !== "none" && !https.secret) {
    return { ok: false, errors: [`https authMethod "${https.authMethod}" requires a secret`] };
  }

  const mappingPlan = buildHttpsMapping(table, input.mapOverrides);
  if (mappingPlan.errors.length > 0) return { ok: false, errors: mappingPlan.errors };

  const filter = input.filter ?? [];
  const params = input.params ?? {};
  try {
    resolveJobFilter(filter, columnTypesOf(table), params, undefined, connection.sourceTimeZone);
  } catch (err) {
    return { ok: false, errors: [describeError(err)] };
  }

  if (input.schedule !== undefined) {
    try {
      validateCronExpression(input.schedule);
    } catch (err) {
      if (err instanceof InvalidCronScheduleError) return { ok: false, errors: [err.message] };
      throw err;
    }
  }

  let watermarkReport: WatermarkColumnReport | undefined;
  if (strategy === "upsertDelta") {
    const check = await validateUpsertDelta(
      strategy,
      connection,
      table,
      input.sourceTable,
      input.watermarkColumn,
      filter,
      params,
      input.replaceSchedule,
      dir,
    );
    if (!check.ok) return { ok: false, errors: [check.error] };
    watermarkReport = check.report;
  }

  const preview: JobMappingPreview = { pairs: mappingPlan.pairs, sentAsNull: [] };
  options.onPlan?.(preview);
  const confirmed = await (options.confirm?.(preview) ?? true);
  if (!confirmed) return { ok: false, errors: ["aborted: not confirmed"] };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeyRef = https.authMethod === "none" ? undefined : secrets.put({ secret: https.secret });

  const job: SyncJobEntry = {
    id: input.id ?? randomUUID(),
    name: input.name,
    connectionId: input.connectionId,
    sourceTable: input.sourceTable,
    targetUrl: input.targetUrl,
    pushKeyRef,
    destinationType: "https",
    https: {
      authMethod: https.authMethod,
      headerName: https.authMethod === "apiKey" ? https.headerName : undefined,
      username: https.authMethod === "basic" ? https.username : undefined,
      rowsField: https.rowsField,
    },
    strategy,
    mapping: mappingPlan.pairs,
    targetSchemaSnapshot: { columns: [], keyColumns: [] },
    onNullKey: input.onNullKey ?? "stop",
    allowEmptyReplace: input.allowEmptyReplace ?? false,
    filter,
    params,
    schedule: input.schedule,
    watermarkColumn: strategy === "upsertDelta" ? input.watermarkColumn : undefined,
    overlapSeconds: strategy === "upsertDelta" ? input.overlapSeconds : undefined,
    replaceSchedule: strategy === "upsertDelta" ? input.replaceSchedule : undefined,
    deleteMode: undefined,
    maxDeletePercent: undefined,
    softDeleteColumn: undefined,
    pollIntervalSeconds: undefined,
    reconciliationIntervalSeconds: undefined,
  };

  saveConfig(upsertJob(config, job), dir);
  return { ok: true, job, sentAsNull: [], watermarkReport };
}

export interface TestJobResult {
  ok: boolean;
  errors: string[];
  /** Present whenever the job itself was found, even on failure — the CLI uses this to print the job's filter/params. */
  job?: SyncJobEntry;
  /** `strategy: "upsertDelta"` only — the null-count/clock-skew report, informational (never fails the test on its own). */
  watermarkReport?: WatermarkColumnReport;
}

/**
 * `nia-agent job test <id>`: re-checks connection + schema against the
 * saved snapshot, confirms the mapped source columns still exist, and
 * (for `strategy: "upsertDelta"`) reports the watermark column's
 * null-count/clock-skew check (plan §1.1/§8, slice C1).
 */
export async function testJob(id: string, dir = defaultHomeDir()): Promise<TestJobResult> {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return { ok: false, errors: [`no job with id ${JSON.stringify(id)}`] };
  const connection = findConnection(config, job.connectionId);
  if (!connection) return { ok: false, errors: [`no connection with id ${JSON.stringify(job.connectionId)}`] };

  if (job.destinationType === "https") return testHttpsJob(job, connection, dir);

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef!);
  if (!pushKeySecret) return { ok: false, errors: [`push key for job ${id} is missing from the secret store`] };

  const errors: string[] = [];
  let liveSchema: TableSchema | undefined;
  const client = new PlanometryClient({ tableUrl: job.targetUrl, pushKey: pushKeySecret.pushKey });
  try {
    await client.checkConnection();
    const schema = await client.getSchema();
    liveSchema = schema;

    const columnByName = new Map(schema.columns.map((c) => [c.name, c]));
    for (const snapshotColumn of job.targetSchemaSnapshot.columns) {
      const live = columnByName.get(snapshotColumn.name);
      if (!live) {
        errors.push(`target column "${snapshotColumn.name}" was removed from the target schema`);
        continue;
      }
      if (live.type !== snapshotColumn.type) {
        errors.push(`target column "${snapshotColumn.name}" was retyped from ${snapshotColumn.type} to ${live.type}`);
      }
    }

    const sameKeys =
      schema.keyColumns.length === job.targetSchemaSnapshot.keyColumns.length &&
      schema.keyColumns.every((k) => job.targetSchemaSnapshot.keyColumns.includes(k));
    if (!sameKeys) errors.push("the target table's key columns have changed since this job was added");
  } catch (err) {
    errors.push(describeError(err));
  } finally {
    await client.close();
  }

  let watermarkReport: WatermarkColumnReport | undefined;
  const catalogResult = await readSourceTable(connection, job.sourceTable, dir);
  if (!catalogResult.ok) {
    errors.push(catalogResult.error);
  } else {
    const sourceNames = new Set(catalogResult.table.columns.map((c) => c.name));
    for (const pair of job.mapping) {
      if (!sourceNames.has(pair.source)) errors.push(`source column "${pair.source}" no longer exists in the catalog`);
    }

    try {
      resolveJobFilter(job.filter, columnTypesOf(catalogResult.table), job.params, undefined, connection.sourceTimeZone);
    } catch (err) {
      errors.push(describeError(err));
    }

    if (liveSchema && !connection.sourceTimeZone) {
      const sourceByName = new Map(catalogResult.table.columns.map((c) => [c.name, c]));
      const targetByName = new Map(liveSchema.columns.map((c) => [c.name, c]));
      for (const pair of job.mapping) {
        const sourceColumn = sourceByName.get(pair.source);
        const targetColumn = targetByName.get(pair.target);
        if (sourceColumn?.type === "datetime" && targetColumn?.type === "DateTime") {
          errors.push(
            `source column "${pair.source}" maps to DateTime target column "${pair.target}", but the connection has no sourceTimeZone set`,
          );
        }
      }
    }

    if (job.strategy === "upsertDelta" && job.watermarkColumn) {
      if (!sourceNames.has(job.watermarkColumn)) {
        errors.push(`watermark column "${job.watermarkColumn}" no longer exists in the catalog`);
      } else {
        try {
          watermarkReport = await withConnectedPool(connection, dir, (pool) => checkWatermarkColumn(pool, job.sourceTable, job.watermarkColumn!));
        } catch (err) {
          errors.push(describeError(err));
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, job, watermarkReport };
}

/**
 * `destinationType: "https"` branch of `testJob` (slice R2): there is no
 * live target schema/connection check to make (an HTTPS destination
 * exposes no `/schema`-equivalent endpoint), so this re-validates only
 * what `testJob` can for Planometry without a network round trip to the
 * destination itself: the address shape, the mapped source columns still
 * existing, the filter still resolving, and (for `strategy:
 * "upsertDelta"`) the watermark column report.
 */
async function testHttpsJob(job: SyncJobEntry, connection: ConnectionEntry, dir: string): Promise<TestJobResult> {
  const errors: string[] = [];
  const addressCheck = validateHttpsAddress(job.targetUrl);
  if (!addressCheck.ok) errors.push(addressCheck.error);

  let watermarkReport: WatermarkColumnReport | undefined;
  const catalogResult = await readSourceTable(connection, job.sourceTable, dir);
  if (!catalogResult.ok) {
    errors.push(catalogResult.error);
  } else {
    const sourceNames = new Set(catalogResult.table.columns.map((c) => c.name));
    for (const pair of job.mapping) {
      if (!sourceNames.has(pair.source)) errors.push(`source column "${pair.source}" no longer exists in the catalog`);
    }

    try {
      resolveJobFilter(job.filter, columnTypesOf(catalogResult.table), job.params, undefined, connection.sourceTimeZone);
    } catch (err) {
      errors.push(describeError(err));
    }

    if (job.strategy === "upsertDelta" && job.watermarkColumn) {
      if (!sourceNames.has(job.watermarkColumn)) {
        errors.push(`watermark column "${job.watermarkColumn}" no longer exists in the catalog`);
      } else {
        try {
          watermarkReport = await withConnectedPool(connection, dir, (pool) => checkWatermarkColumn(pool, job.sourceTable, job.watermarkColumn!));
        } catch (err) {
          errors.push(describeError(err));
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, job, watermarkReport };
}

/** `nia-agent job list`: non-secret summary only — never the push key. */
export function listJobs(dir = defaultHomeDir()): SyncJobEntry[] {
  return loadConfig(dir).jobs;
}

/** `nia-agent job remove <id>`: removes the job, its push key from the secret store, and (if present) its key reconciliation list (§10 slice D1). */
export async function removeJob(id: string, dir = defaultHomeDir()): Promise<boolean> {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return false;

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  if (job.pushKeyRef) secrets.delete(job.pushKeyRef);
  await removeKeyList(dir, id);

  saveConfig(removeFromConfig(config, id), dir);
  return true;
}

/** `nia-agent job pause <id>`: manually pauses a job — the scheduler skips it until `job resume`; `job run` still works on it. */
export function pauseJob(id: string, reason: string, dir = defaultHomeDir()): boolean {
  const job = findJob(loadConfig(dir), id);
  if (!job) return false;
  pauseJobState(id, reason, dir);
  return true;
}

/** `nia-agent job resume <id>`: clears a job's paused state, whether it was paused manually or by the scheduler. */
export function resumeJob(id: string, dir = defaultHomeDir()): boolean {
  const job = findJob(loadConfig(dir), id);
  if (!job) return false;
  resumeJobState(id, dir);
  return true;
}

export interface UpdateJobInput {
  name?: string;
  targetUrl?: string;
  rekey?: string;
  mapOverrides?: RawMappingPair[];
  unmapTargets?: string[];
  onNullKey?: OnNullKey;
  allowEmptyReplace?: boolean;
  /** Replaces the job's whole filter (it's "a list of conditions joined with AND", treated as one unit) — undefined leaves it unchanged. */
  filter?: JobFilterCondition[];
  /** Merged into the job's existing saved params (overwriting by key) — undefined leaves them unchanged. */
  params?: Record<string, string>;
  /** 5-field cron expression, evaluated in the connection's sourceTimeZone — undefined leaves it unchanged; pass "" to clear it. */
  schedule?: string;
  /** Undefined leaves the job's strategy unchanged. */
  strategy?: JobStrategy;
  /** Undefined leaves it unchanged. Required (on the effective job) when the effective strategy is "upsertDelta". Changing this changes the job's fingerprint (sync/watermark.ts's computeJobFingerprint), so the next run treats the saved watermark as stale — see the comment near the bottom of updateJob. */
  watermarkColumn?: string;
  /** Undefined leaves it unchanged. */
  overlapSeconds?: number;
  /** Undefined leaves it unchanged; pass "" to clear it. */
  replaceSchedule?: string;
  /** Undefined leaves it unchanged; pass "none" to clear it. */
  deleteMode?: DeleteMode;
  /** Undefined leaves it unchanged (or defaults to 20 if `deleteMode` is being newly set to "reconciliation"). */
  maxDeletePercent?: number;
  /** Undefined leaves it unchanged (or is required if `deleteMode` is being newly set to "softDelete"). */
  softDeleteColumn?: string;
  /** `strategy: "realtime"` only (§1.3/E1) — undefined leaves it unchanged (or defaults to 60 if the effective strategy is newly set to "realtime"). */
  pollIntervalSeconds?: number;
  /** `strategy: "realtime"` + `deleteMode: "reconciliation"` only (§1.3/E1) — undefined leaves it unchanged (or defaults to 600 if newly applicable). */
  reconciliationIntervalSeconds?: number;
}

/**
 * `nia-agent job update <id>`: re-runs the same validation as `job add`
 * against the (possibly new) target URL/key, merging the job's existing
 * mapping with `--map`/`--unmap` as the override baseline. A failed
 * validation leaves the job (and its stored push key) unchanged.
 */
export async function updateJob(
  id: string,
  input: UpdateJobInput,
  options: JobCommandOptions = {},
  dir = defaultHomeDir(),
): Promise<JobCommandResult> {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return { ok: false, errors: [`no job with id ${JSON.stringify(id)}`] };
  if (job.destinationType === "https") {
    return { ok: false, errors: ['job update is not yet supported for destinationType "https" — remove and re-add the job instead'] };
  }
  const connection = findConnection(config, job.connectionId);
  if (!connection) return { ok: false, errors: [`no connection with id ${JSON.stringify(job.connectionId)}`] };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const existingPushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef!);
  if (!existingPushKeySecret) return { ok: false, errors: [`push key for job ${id} is missing from the secret store`] };
  const pushKey = input.rekey ?? existingPushKeySecret.pushKey;
  const targetUrl = input.targetUrl ?? job.targetUrl;

  const catalogResult = await readSourceTable(connection, job.sourceTable, dir);
  if (!catalogResult.ok) return { ok: false, errors: [catalogResult.error] };

  const client = new PlanometryClient({ tableUrl: targetUrl, pushKey });
  let schema: TableSchema;
  try {
    await client.checkConnection();
    schema = await client.getSchema();
  } catch (err) {
    return { ok: false, errors: [describeError(err)] };
  } finally {
    await client.close();
  }

  const unmapTargets = new Set(input.unmapTargets ?? []);
  const baseOverrides = new Map(job.mapping.filter((p) => !unmapTargets.has(p.target)).map((p) => [p.target, p.source]));
  for (const o of input.mapOverrides ?? []) baseOverrides.set(o.target, o.source);
  const overrides: RawMappingPair[] = [...baseOverrides.entries()].map(([target, source]) => ({ source, target }));

  const plan = buildMapping(catalogResult.table, schema.columns, schema.keyColumns, overrides, connection.sourceTimeZone);
  if (plan.errors.length > 0) return { ok: false, errors: plan.errors };

  const filter = input.filter ?? job.filter;
  const params = input.params ? { ...job.params, ...input.params } : job.params;
  try {
    resolveJobFilter(filter, columnTypesOf(catalogResult.table), params, undefined, connection.sourceTimeZone);
  } catch (err) {
    return { ok: false, errors: [describeError(err)] };
  }

  const schedule = input.schedule !== undefined ? (input.schedule === "" ? undefined : input.schedule) : job.schedule;
  if (schedule !== undefined) {
    try {
      validateCronExpression(schedule);
    } catch (err) {
      if (err instanceof InvalidCronScheduleError) return { ok: false, errors: [err.message] };
      throw err;
    }
  }

  const strategy: JobStrategy = input.strategy ?? job.strategy;
  const watermarkColumn = input.watermarkColumn ?? (strategy === job.strategy ? job.watermarkColumn : undefined);
  const overlapSeconds = input.overlapSeconds ?? job.overlapSeconds;
  const replaceSchedule = input.replaceSchedule !== undefined ? (input.replaceSchedule === "" ? undefined : input.replaceSchedule) : job.replaceSchedule;
  const deleteMode = input.deleteMode ?? (strategy === job.strategy ? job.deleteMode : undefined);
  const maxDeletePercent =
    input.maxDeletePercent ?? (deleteMode === "reconciliation" ? job.maxDeletePercent ?? DEFAULT_MAX_DELETE_PERCENT : undefined);
  const softDeleteColumn = input.softDeleteColumn ?? (deleteMode === "softDelete" ? job.softDeleteColumn : undefined);

  let watermarkReport: WatermarkColumnReport | undefined;
  if (strategy === "upsertDelta" || strategy === "realtime") {
    const check = await validateUpsertDelta(strategy, connection, catalogResult.table, job.sourceTable, watermarkColumn, filter, params, replaceSchedule, dir);
    if (!check.ok) return { ok: false, errors: [check.error] };
    watermarkReport = check.report;
  }

  const deleteModeCheck = validateDeleteMode(strategy, deleteMode, maxDeletePercent, softDeleteColumn, catalogResult.table);
  if (!deleteModeCheck.ok) return { ok: false, errors: [deleteModeCheck.error] };

  let realtimeIntervals: { pollIntervalSeconds: number; reconciliationIntervalSeconds: number | undefined } | undefined;
  if (strategy === "realtime") {
    const pollIntervalSeconds =
      input.pollIntervalSeconds ?? (strategy === job.strategy ? job.pollIntervalSeconds : undefined);
    const reconciliationIntervalSeconds =
      input.reconciliationIntervalSeconds ?? (strategy === job.strategy ? job.reconciliationIntervalSeconds : undefined);
    const check = validateRealtimeIntervals(pollIntervalSeconds, reconciliationIntervalSeconds, deleteMode);
    if (!check.ok) return { ok: false, errors: [check.error] };
    realtimeIntervals = check;
  }

  const preview: JobMappingPreview = { pairs: plan.pairs, sentAsNull: plan.sentAsNull };
  options.onPlan?.(preview);
  const confirmed = await (options.confirm?.(preview) ?? true);
  if (!confirmed) return { ok: false, errors: ["aborted: not confirmed"] };

  const pushKeyRef = input.rekey ? secrets.put({ pushKey: input.rekey }) : job.pushKeyRef;

  const updated: SyncJobEntry = {
    ...job,
    name: input.name ?? job.name,
    targetUrl,
    pushKeyRef,
    mapping: plan.pairs,
    targetSchemaSnapshot: buildTargetSchemaSnapshot(schema, plan.pairs),
    onNullKey: input.onNullKey ?? job.onNullKey,
    allowEmptyReplace: input.allowEmptyReplace ?? job.allowEmptyReplace,
    filter,
    params,
    schedule,
    strategy,
    watermarkColumn: strategy === "upsertDelta" || strategy === "realtime" ? watermarkColumn : undefined,
    overlapSeconds: strategy === "upsertDelta" || strategy === "realtime" ? overlapSeconds : undefined,
    replaceSchedule: strategy === "upsertDelta" || strategy === "realtime" ? replaceSchedule : undefined,
    deleteMode: strategy === "upsertDelta" || strategy === "realtime" ? deleteMode : undefined,
    maxDeletePercent:
      (strategy === "upsertDelta" || strategy === "realtime") && deleteMode === "reconciliation" ? maxDeletePercent : undefined,
    softDeleteColumn:
      (strategy === "upsertDelta" || strategy === "realtime") && deleteMode === "softDelete" ? softDeleteColumn : undefined,
    pollIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.pollIntervalSeconds : undefined,
    reconciliationIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.reconciliationIntervalSeconds : undefined,
  };

  saveConfig(upsertJob(config, updated), dir);
  if (input.rekey) secrets.delete(job.pushKeyRef!);

  // No explicit watermark invalidation needed here (task item 1, the
  // fingerprint rule): a changed source table/filter/params/mapping/
  // watermark column/target URL changes the job's fingerprint
  // (sync/watermark.ts's computeJobFingerprint), so cli/runJobCommand.ts
  // naturally treats the now-stale saved watermark as absent on the next
  // run, without this command having to clear anything itself.

  const warnings = (strategy === "upsertDelta" || strategy === "realtime") && deleteMode === "softDelete" ? [SOFT_DELETE_FILTER_WARNING] : undefined;
  return { ok: true, job: updated, sentAsNull: plan.sentAsNull, watermarkReport, warnings };
}

type ReadSourceTableResult = { ok: true; table: CatalogTable } | { ok: false; error: string };

async function readSourceTable(connection: ConnectionEntry, sourceTable: string, dir: string): Promise<ReadSourceTableResult> {
  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(connection.credentialRef);
  if (!credentials) return { ok: false, error: `credentials for connection ${connection.id} are missing from the secret store` };

  const pool = await connect({
    server: connection.sqlserver.host,
    port: connection.sqlserver.port,
    database: connection.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: connection.sqlserver.encrypt,
    allowLegacyTls: connection.sqlserver.allowLegacyTls,
    trustServerCertificate: connection.sqlserver.trustServerCertificate,
  });
  try {
    const catalog = await introspectCatalog(pool, connection.sourceTimeZone);
    const table = catalog.tables.find((t) => t.name === sourceTable);
    if (!table) return { ok: false, error: `source table/view "${sourceTable}" was not found in the catalog` };
    return { ok: true, table };
  } finally {
    await pool.close();
  }
}

function buildTargetSchemaSnapshot(schema: TableSchema, pairs: JobMappingColumn[]): TargetSchemaSnapshot {
  const columnByName = new Map(schema.columns.map((c) => [c.name, c]));
  return {
    columns: pairs.map((p) => {
      const column = columnByName.get(p.target)!;
      return { name: p.target, type: column.type, isKey: schema.keyColumns.includes(p.target) };
    }),
    keyColumns: schema.keyColumns,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
