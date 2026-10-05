import { connect, introspectCatalog } from "@nia/extract/mssql";
import { defaultHomeDir } from "../config/paths.js";
import { findConnection, loadConfig } from "../config/store.js";
import type { ConnectionEntry } from "../config/types.js";
import type { Logger } from "../ops/logger.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import type { TaskResultsClient } from "./taskResultsClient.js";
import type { AgentTask } from "./transport.js";

// Strictly ≤ the bridge's own per-kind task timeout (services/agent-
// bridge/src/internalApp.ts's TASK_TIMEOUT_MS) so this agent never
// "finishes late" relative to the bridge's own give-up point.
const TASK_TIMEOUT_MS: Record<AgentTask["kind"], number> = {
  test_connection: 8_000,
  list_tables: 10_000,
};

// Small fixed pool (plan §3 point 1) — local task execution never
// competes meaningfully with jobScheduler.ts's own work, so this stays
// modest rather than configurable.
const MAX_CONCURRENT_TASKS = 3;

type TaskOutcome = { status: "done"; result: unknown } | { status: "failed"; errorClass: string };

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
  task: AgentTask,
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
    // nullable (not part of that contract). introspectCatalog never
    // computes a single-column PK, so primaryKey is always null here.
    const catalog = await introspectCatalog(pool, entry.sourceTimeZone);
    const entities = catalog.tables.map((table) => {
      const dot = table.name.indexOf(".");
      const namespace = dot === -1 ? "dbo" : table.name.slice(0, dot);
      const name = dot === -1 ? table.name : table.name.slice(dot + 1);
      return {
        namespace,
        name,
        fields: table.columns.map((column) => ({ name: column.name, type: column.type })),
        primaryKey: null,
      };
    });
    return { status: "done", result: { entities } };
  } finally {
    await pool.close();
  }
}

async function runOneTask(task: AgentTask, dir: string): Promise<TaskOutcome> {
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
 * Slice C1 — fully separate from scheduler/jobScheduler.ts (own
 * lifecycle, own concurrency, never touches sync jobs). Receives tasks
 * delivered on check-in (`CheckInLoopOptions.onTasks`), runs them with
 * bounded concurrency, and POSTs each result immediately via
 * TaskResultsClient the moment it finishes — not queued for the next
 * check-in.
 */
export class TaskRunner {
  private readonly queue: AgentTask[] = [];
  private active = 0;

  constructor(
    private readonly resultsClient: TaskResultsClient,
    private readonly logger: Logger,
    private readonly dir: string = defaultHomeDir(),
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
    const outcome = await runOneTask(task, this.dir);
    this.logger.info("agent_task_completed", { taskId: task.id, kind: task.kind, status: outcome.status });
    await this.resultsClient.post({
      taskId: task.id,
      status: outcome.status,
      ...(outcome.status === "done" ? { result: outcome.result } : { errorClass: outcome.errorClass }),
    });
  }
}
