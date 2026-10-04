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
import type { ConnectionEntry, JobMappingColumn, JobStrategy, OnNullKey, SyncJobEntry, TargetSchemaSnapshot } from "../config/types.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { PlanometryClient } from "../planometry/client.js";
import { isRelativeDateToken, resolveJobFilter, type FilterValueOrParam, type JobFilterCondition } from "../planometry/parameters.js";
import type { TableSchema } from "../planometry/types.js";
import { pauseJobState, resumeJobState } from "../ops/state.js";
import { InvalidCronScheduleError, validateCronExpression } from "../scheduler/cronSchedule.js";
import { checkWatermarkColumn, type WatermarkColumnReport } from "../sync/watermark.js";
import { buildMapping, type RawMappingPair } from "./jobMapping.js";

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
 * `strategy: "upsertDelta"` validation shared by `addJob`/`updateJob`
 * (plan §1.1/§2/§8): the watermark column must exist in the live source
 * catalog and be a datetime-family column; a relative-date filter
 * parameter requires a `replaceSchedule`; a given `replaceSchedule` must
 * itself be a valid cron expression. Returns the null-count/clock-skew
 * report on success, for the caller to attach to its result.
 */
async function validateUpsertDelta(
  connection: ConnectionEntry,
  table: CatalogTable,
  sourceTable: string,
  watermarkColumn: string | undefined,
  filter: JobFilterCondition[],
  params: Record<string, string>,
  replaceSchedule: string | undefined,
  dir: string,
): Promise<{ ok: true; report: WatermarkColumnReport } | { ok: false; error: string }> {
  if (!watermarkColumn) return { ok: false, error: `strategy "upsertDelta" requires a watermarkColumn` };
  const column = table.columns.find((c) => c.name === watermarkColumn);
  if (!column) return { ok: false, error: `watermark column "${watermarkColumn}" was not found in the catalog` };
  if (column.type !== "datetime") return { ok: false, error: `watermark column "${watermarkColumn}" is type ${column.type}, not a datetime-family column` };

  if (filterUsesRelativeDateToken(filter, params) && replaceSchedule === undefined) {
    return { ok: false, error: `a filter using a relative-date token requires a replaceSchedule (periodic full replace) for an "upsertDelta" job` };
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
}

export interface AddJobInput {
  id?: string;
  name: string;
  connectionId: string;
  sourceTable: string;
  targetUrl: string;
  pushKey: string;
  mapOverrides: RawMappingPair[];
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
  /** Default "replace" (§10 slice C1). */
  strategy?: JobStrategy;
  /** `strategy: "upsertDelta"` only — required then. */
  watermarkColumn?: string;
  /** `strategy: "upsertDelta"` only — default 300, applied where read. */
  overlapSeconds?: number;
  /** `strategy: "upsertDelta"` only — required when `filter` uses a relative-date token. */
  replaceSchedule?: string;
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

  const catalogResult = await readSourceTable(connection, input.sourceTable, dir);
  if (!catalogResult.ok) return { ok: false, errors: [catalogResult.error] };

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
  if (strategy === "upsertDelta") {
    const check = await validateUpsertDelta(
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
    watermarkColumn: strategy === "upsertDelta" ? input.watermarkColumn : undefined,
    overlapSeconds: strategy === "upsertDelta" ? input.overlapSeconds : undefined,
    replaceSchedule: strategy === "upsertDelta" ? input.replaceSchedule : undefined,
  };

  saveConfig(upsertJob(config, job), dir);
  return { ok: true, job, sentAsNull: plan.sentAsNull, watermarkReport };
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

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const pushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef);
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

/** `nia-agent job list`: non-secret summary only — never the push key. */
export function listJobs(dir = defaultHomeDir()): SyncJobEntry[] {
  return loadConfig(dir).jobs;
}

/** `nia-agent job remove <id>`: removes the job and its push key from the secret store. */
export function removeJob(id: string, dir = defaultHomeDir()): boolean {
  const config = loadConfig(dir);
  const job = findJob(config, id);
  if (!job) return false;

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  secrets.delete(job.pushKeyRef);

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
  const connection = findConnection(config, job.connectionId);
  if (!connection) return { ok: false, errors: [`no connection with id ${JSON.stringify(job.connectionId)}`] };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const existingPushKeySecret = secrets.get<{ pushKey: string }>(job.pushKeyRef);
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

  let watermarkReport: WatermarkColumnReport | undefined;
  if (strategy === "upsertDelta") {
    const check = await validateUpsertDelta(connection, catalogResult.table, job.sourceTable, watermarkColumn, filter, params, replaceSchedule, dir);
    if (!check.ok) return { ok: false, errors: [check.error] };
    watermarkReport = check.report;
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
    watermarkColumn: strategy === "upsertDelta" ? watermarkColumn : undefined,
    overlapSeconds: strategy === "upsertDelta" ? overlapSeconds : undefined,
    replaceSchedule: strategy === "upsertDelta" ? replaceSchedule : undefined,
  };

  saveConfig(upsertJob(config, updated), dir);
  if (input.rekey) secrets.delete(job.pushKeyRef);

  // No explicit watermark invalidation needed here (task item 1, the
  // fingerprint rule): a changed source table/filter/params/mapping/
  // watermark column/target URL changes the job's fingerprint
  // (sync/watermark.ts's computeJobFingerprint), so cli/runJobCommand.ts
  // naturally treats the now-stale saved watermark as absent on the next
  // run, without this command having to clear anything itself.

  return { ok: true, job: updated, sentAsNull: plan.sentAsNull, watermarkReport };
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
