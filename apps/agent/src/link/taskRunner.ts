import { connect, extractKeysetBatch, introspectCatalog } from "@nia/extract/mssql";
import type { ExtractRequest, ExtractType, FilterCondition } from "@nia/extract";
import { pauseJob, resumeJob, testJob } from "../cli/jobCommands.js";
import { defaultHomeDir } from "../config/paths.js";
import { findConnection, findJob, loadConfig } from "../config/store.js";
import type { ConnectionEntry } from "../config/types.js";
import type { Logger } from "../ops/logger.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { BatchTooLargeError, type ReadBatchUploadClient, type UploadedBatch } from "./readBatchUploadClient.js";
import type { TaskResultsClient } from "./taskResultsClient.js";
import type { AgentTask, StructuredQueryCursor } from "./transport.js";

// Strictly ≤ the bridge's own per-kind task timeout (services/agent-
// bridge/src/internalApp.ts's TASK_TIMEOUT_MS) so this agent never
// "finishes late" relative to the bridge's own give-up point. Slice
// R5b's four action kinds act on a local job rather than a live SQL
// Server connection: run_now/pause/resume only ever start or flip local
// state (never await the run itself), so a short timeout is plenty;
// test_job re-checks a live connection/schema like list_tables, so it
// gets the same budget.
const TASK_TIMEOUT_MS: Record<AgentTask["kind"], number> = {
  test_connection: 8_000,
  list_tables: 45_000,
  run_now: 5_000,
  pause: 5_000,
  resume: 5_000,
  test_job: 45_000,
  // Matches the bridge's own READ_BATCH_TASK_TIMEOUT_MS (internalApp.ts) —
  // same "never finish late relative to the bridge's own give-up point"
  // convention as every other kind here, even though the bridge itself
  // only synchronously awaits the first of up to 10 batches this task
  // may upload.
  read_batch: 40_000,
};

// Slice T2, plan point 3 — same 20 MB cap the bridge enforces server-side
// (services/agent-bridge/src/app.ts's READ_BATCH_UPLOAD_MAX_BYTES),
// duplicated per-side by the same convention as every other cross-
// service constant in this codebase (writeSignature.ts's header).
const READ_BATCH_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

// Small fixed pool (plan §3 point 1) — local task execution never
// competes meaningfully with jobScheduler.ts's own work, so this stays
// modest rather than configurable. Read tasks share this same pool
// (plan point 4: "read tasks run beside jobs without delaying them, with
// a limit on how many run at once") rather than getting a separate
// sub-limit — one bounded pool already satisfies both halves of that
// requirement without a second knob.
const MAX_CONCURRENT_TASKS = 3;

type TaskOutcome = { status: "done"; result: unknown } | { status: "failed"; errorClass: string };

type WireColumnType = UploadedBatch["columns"][number]["type"];

// Slice T2 — the bridge's upload route validates columns[].type against
// its own wire-level ColumnType (packages/schemas/src/tabular.ts), a
// different, 7-value enum from this package's 5-value ExtractType
// (packages/extract/src/types.ts). "datetime" has no exact counterpart
// on the wire side, so it collapses to "date" — same lossy direction
// Planometry's own ExtractType->ColumnType table (planometry/
// typeCompatibility.ts) already takes for that case, just against a
// different target enum.
const EXTRACT_TYPE_TO_WIRE_COLUMN_TYPE: Record<ExtractType, WireColumnType> = {
  text: "string",
  number: "number",
  date: "date",
  datetime: "date",
  boolean: "boolean",
};

function toWireColumns(columns: { name: string; type: ExtractType }[]): UploadedBatch["columns"] {
  return columns.map((c) => ({ name: c.name, type: EXTRACT_TYPE_TO_WIRE_COLUMN_TYPE[c.type] }));
}

type ConnectionTask = Extract<AgentTask, { kind: "test_connection" | "list_tables" }>;
type SetupActionTask = Extract<AgentTask, { kind: "run_now" | "pause" | "resume" | "test_job" }>;
type ReadBatchTask = Extract<AgentTask, { kind: "read_batch" }>;

/**
 * Slice R5b (docs/plans/agent-canvas-integration.md B.7) — the one piece
 * of `run_now` that TaskRunner can't do on its own: starting the job
 * through the scheduler's own lock/concurrency-semaphore/run-report
 * path. Kept as a small structural interface (rather than importing
 * `JobScheduler` directly) so a test's fake runner can be a plain object
 * literal — `JobScheduler.runNow` (scheduler/jobScheduler.ts) matches
 * this shape exactly, and that's the real implementation agentLoop.ts
 * wires in.
 */
export interface JobActionRunner {
  runNow(
    jobId: string,
    forceReplace: boolean,
    extra?: { paramOverrides?: Record<string, string>; allowMassDelete?: boolean },
  ): { ok: true } | { ok: false; error: string };
}

/**
 * `connect()`/`introspectCatalog()` have no abort-signal support, so a
 * hung task can't be cancelled outright — this races the real work
 * against a timer and gives up waiting at `timeoutMs`, exactly matching
 * the bridge's own give-up point. The underlying connection attempt (if
 * still running) is abandoned, not torn down — acceptable here since a
 * stuck local SQL Server connect() is rare and the process-level
 * consequence (one extra lingering socket) is negligible next to never
 * answering the bridge at all.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTaskBody(
  task: ConnectionTask,
  entry: ConnectionEntry,
  credentials: { user: string; password: string },
): Promise<TaskOutcome> {
  const start = Date.now();
  const pool = await connect({
    server: entry.sqlserver.host,
    port: entry.sqlserver.port,
    database: entry.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: entry.sqlserver.encrypt,
    allowLegacyTls: entry.sqlserver.allowLegacyTls,
    trustServerCertificate: entry.sqlserver.trustServerCertificate,
  });
  try {
    if (task.kind === "test_connection") {
      await pool.request().query("SELECT 1");
      return { status: "done", result: { ok: true, latencyMs: Date.now() - start } };
    }

    // list_tables: @nia/extract/mssql's Catalog shape (tables: [{name:
    // "schema.table", columns: [{name, type, nullable}]}]) differs from
    // the platform's IntrospectResponse.entities shape (packages/schemas/
    // src/contract.ts) — split the schema-qualified name and drop
    // nullable (not part of that contract). IntrospectResponse.entity.
    // primaryKey is single-column only (that field's own doc comment: a
    // composite key is collapsed to null, "treated the same as no key
    // found") — table.primaryKey here is @nia/extract's own genuinely
    // composite-aware array (Slice T2), so only a single-column PK ever
    // survives the collapse to the wire shape below.
    const catalog = await introspectCatalog(pool, entry.sourceTimeZone);
    const entities = catalog.tables.map((table) => {
      const dot = table.name.indexOf(".");
      const namespace = dot === -1 ? "dbo" : table.name.slice(0, dot);
      const name = dot === -1 ? table.name : table.name.slice(dot + 1);
      return {
        namespace,
        name,
        fields: table.columns.map((column) => ({ name: column.name, type: column.type })),
        primaryKey: table.primaryKey && table.primaryKey.length === 1 ? table.primaryKey[0]! : null,
      };
    });
    return { status: "done", result: { entities } };
  } finally {
    await pool.close();
  }
}

async function runConnectionTask(task: ConnectionTask, dir: string): Promise<TaskOutcome> {
  const config = loadConfig(dir);
  const entry = findConnection(config, task.localConnectionId);
  if (!entry) return { status: "failed", errorClass: `no local connection with id ${JSON.stringify(task.localConnectionId)}` };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
  if (!credentials) return { status: "failed", errorClass: "credentials are missing from the secret store" };

  try {
    return await withTimeout(runTaskBody(task, entry, credentials), TASK_TIMEOUT_MS[task.kind], "task timed out");
  } catch (err) {
    return { status: "failed", errorClass: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Slice T2, plan point 4 — a keyset-paged read through packages/extract,
 * uploading each batch to the bridge as soon as it's read (plan point 2's
 * read-ahead: up to `task.payload.batchCount` batches, one task). The
 * wire-level cursor (StructuredQueryCursor, packages/schemas/src/
 * contract.ts) is single-column only by contract — a composite primary
 * key collapses to `IntrospectResponse.entity.primaryKey: null`, so the
 * worker can never have issued a non-null cursor for one of these tables
 * in the first place (the opening request always carries `cursor: null`).
 * Reading exactly one batch and reporting `isLast: true` unconditionally
 * for a composite-keyed table keeps this handler correct for that case
 * without ever constructing a multi-column wire cursor the contract has
 * no room for — packages/extract's own `extractKeysetBatch` still pages
 * composite keys correctly as a library capability, this is purely about
 * what's representable on the wire back to the bridge.
 */
async function runReadBatchTaskBody(
  task: ReadBatchTask,
  entry: ConnectionEntry,
  credentials: { user: string; password: string },
  uploadClient: ReadBatchUploadClient,
): Promise<TaskOutcome> {
  const pool = await connect({
    server: entry.sqlserver.host,
    port: entry.sqlserver.port,
    database: entry.sqlserver.database,
    user: credentials.user,
    password: credentials.password,
    encrypt: entry.sqlserver.encrypt,
    allowLegacyTls: entry.sqlserver.allowLegacyTls,
    trustServerCertificate: entry.sqlserver.trustServerCertificate,
  });
  try {
    const catalog = await introspectCatalog(pool, entry.sourceTimeZone);
    const table = catalog.tables.find((t) => t.name === task.payload.table);
    if (!table) return { status: "failed", errorClass: `table ${JSON.stringify(task.payload.table)} not found` };
    if (!table.primaryKey || table.primaryKey.length === 0) {
      return { status: "failed", errorClass: `table ${JSON.stringify(task.payload.table)} has no primary key` };
    }

    const isComposite = table.primaryKey.length > 1;
    const extractRequest: ExtractRequest = {
      table: task.payload.table,
      columns: task.payload.columns,
      filter: task.payload.filter as unknown as FilterCondition[],
    };

    let cursorWire: StructuredQueryCursor | null = task.payload.cursor;
    let cursorArray: unknown[] | null = cursorWire ? [cursorWire.value] : null;
    let uploaded = 0;

    for (let i = 0; i < task.payload.batchCount; i++) {
      const batch = await extractKeysetBatch(pool, catalog, extractRequest, cursorArray, task.payload.limit);
      const last = isComposite || batch.isLast;
      const nextCursorWire: StructuredQueryCursor | null = last
        ? null
        : { column: table.primaryKey[0]!, value: batch.nextCursor![0] as string | number };

      await uploadClient.upload(
        task.id,
        { cursor: cursorWire, columns: toWireColumns(batch.columns), rows: batch.rows, nextCursor: nextCursorWire, isLast: last },
        READ_BATCH_UPLOAD_MAX_BYTES,
      );
      uploaded += 1;

      if (last) break;
      cursorWire = nextCursorWire;
      cursorArray = batch.nextCursor;
    }
    return { status: "done", result: { batchesUploaded: uploaded } };
  } finally {
    await pool.close();
  }
}

async function runReadBatchTask(
  task: ReadBatchTask,
  dir: string,
  uploadClient: ReadBatchUploadClient | undefined,
): Promise<TaskOutcome> {
  if (!uploadClient) return { status: "failed", errorClass: "read_batch is not available on this agent" };

  const config = loadConfig(dir);
  const entry = findConnection(config, task.payload.localConnectionId);
  if (!entry) return { status: "failed", errorClass: `no local connection with id ${JSON.stringify(task.payload.localConnectionId)}` };

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
  if (!credentials) return { status: "failed", errorClass: "credentials are missing from the secret store" };

  try {
    return await withTimeout(runReadBatchTaskBody(task, entry, credentials, uploadClient), TASK_TIMEOUT_MS.read_batch, "task timed out");
  } catch (err) {
    if (err instanceof BatchTooLargeError) return { status: "failed", errorClass: err.message };
    return { status: "failed", errorClass: err instanceof Error ? err.message : String(err) };
  }
}

/** `payload.params` is attacker/platform-controlled JSON — only trusted as a one-off param override once every value is confirmed to be a plain string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/**
 * Slice R5b — run_now/pause/resume/test_job all act on one platform-
 * managed job, found locally by `task.agentSetupId` (that job's own id
 * — SetupManager uses the setup id as the job id directly, config/
 * types.ts's `platformManaged.setupId`). A setup id this agent doesn't
 * have — never applied, or applied then unpublished/removed — fails
 * with a short, fixed reason; no secrets, row values, or key values
 * ever appear in a task result (task rules).
 */
async function runSetupActionBody(task: SetupActionTask, dir: string, jobRunner: JobActionRunner | undefined): Promise<TaskOutcome> {
  const job = findJob(loadConfig(dir), task.agentSetupId);
  if (!job || !job.platformManaged) return { status: "failed", errorClass: "job not found on this agent" };

  switch (task.kind) {
    case "pause":
      pauseJob(job.id, "paused via a platform action", dir);
      return { status: "done", result: { paused: true } };

    case "resume":
      resumeJob(job.id, dir);
      return { status: "done", result: { resumed: true } };

    case "test_job": {
      const result = await testJob(job.id, dir);
      if (result.ok) return { status: "done", result: { ok: true } };
      return { status: "failed", errorClass: result.errors[0] ?? "job test failed" };
    }

    case "run_now": {
      if (!jobRunner) return { status: "failed", errorClass: "run_now is not available on this agent" };
      const payload = task.payload;
      const forceReplace = payload.fullReload === true;
      const paramOverrides = isStringRecord(payload.params) ? payload.params : undefined;
      const allowMassDelete = payload.allowMassDelete === true;
      // Fire-and-forget by design (jobRunner.runNow never awaits the run
      // itself) — refused synchronously ("already running") if a run for
      // this job is already in flight; otherwise the task is reported
      // "done" the instant the run is accepted, and its real outcome
      // surfaces later through the normal run report (ops/recordRun.ts),
      // never through this task result.
      const outcome = jobRunner.runNow(job.id, forceReplace, { paramOverrides, allowMassDelete });
      if (!outcome.ok) return { status: "failed", errorClass: outcome.error };
      return { status: "done", result: { started: true } };
    }
  }
}

async function runSetupActionTask(task: SetupActionTask, dir: string, jobRunner: JobActionRunner | undefined): Promise<TaskOutcome> {
  try {
    return await withTimeout(runSetupActionBody(task, dir, jobRunner), TASK_TIMEOUT_MS[task.kind], "task timed out");
  } catch (err) {
    return { status: "failed", errorClass: err instanceof Error ? err.message : String(err) };
  }
}

function runOneTask(
  task: AgentTask,
  dir: string,
  jobRunner: JobActionRunner | undefined,
  uploadClient: ReadBatchUploadClient | undefined,
): Promise<TaskOutcome> {
  // A plain `kind === "a" || kind === "b"` check doesn't narrow `task` here (TS doesn't narrow a
  // discriminated union via an OR'd equality check when the discriminant is itself multi-literal
  // per member) — a switch on the same property does.
  switch (task.kind) {
    case "test_connection":
    case "list_tables":
      return runConnectionTask(task, dir);
    case "read_batch":
      return runReadBatchTask(task, dir, uploadClient);
    default:
      return runSetupActionTask(task, dir, jobRunner);
  }
}

/**
 * Slice C1 — fully separate from scheduler/jobScheduler.ts (own
 * lifecycle, own concurrency, never touches sync jobs). Receives tasks
 * delivered on check-in (`CheckInLoopOptions.onTasks`), runs them with
 * bounded concurrency, and POSTs each result immediately via
 * TaskResultsClient the moment it finishes — not queued for the next
 * check-in.
 *
 * Slice R5b adds `run_now`/`pause`/`resume`/`test_job`, which act on a
 * local platform-managed job rather than a connection — `jobRunner` is
 * only consulted for `run_now` (the one action that needs the
 * scheduler's own lock/semaphore), and is optional so an agent build
 * with no scheduler wired in simply refuses that one action kind.
 *
 * Slice T2 adds `read_batch`, consulting `uploadClient` the same way —
 * optional so a build with no upload client simply refuses that kind.
 */
export class TaskRunner {
  private readonly queue: AgentTask[] = [];
  private active = 0;

  constructor(
    private readonly resultsClient: TaskResultsClient,
    private readonly logger: Logger,
    private readonly dir: string = defaultHomeDir(),
    private readonly jobRunner?: JobActionRunner,
    private readonly uploadClient?: ReadBatchUploadClient,
  ) {}

  handle(tasks: AgentTask[]): void {
    this.queue.push(...tasks);
    this.pump();
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_TASKS && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      void this.runAndReport(task).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async runAndReport(task: AgentTask): Promise<void> {
    const outcome = await runOneTask(task, this.dir, this.jobRunner, this.uploadClient);
    this.logger.info("agent_task_completed", { taskId: task.id, kind: task.kind, status: outcome.status });
    await this.resultsClient.post({
      taskId: task.id,
      status: outcome.status,
      ...(outcome.status === "done" ? { result: outcome.result } : { errorClass: outcome.errorClass }),
    });
  }
}
