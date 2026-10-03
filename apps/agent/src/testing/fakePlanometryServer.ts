import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { ColumnType, PlanometryRow, PushMode, PushRequestBody, SchemaColumn } from "../planometry/types.js";

/**
 * Fake v4 Internal Table push server (docs/planometry/connector-guide-v4.md
 * §1-§4, §6b, §7; docs/plans/planometry-v4-migration.md §10 slice A1). A
 * real `node:http` server on an ephemeral port — not a mock of `fetch`.
 *
 * Assumptions made where the guide is silent (worst case for us, listed
 * here per the slice's instructions):
 *   - A resent `replace` part is counted twice in `loadRowsReceived` — the
 *     fake does not try to detect/dedupe a resend of the same part.
 *   - A zero-row `replace` (no `loadId`) empties the table. The fake does
 *     not refuse this; refusing it is the agent's own safety rule (§7),
 *     not something this wire-level fake enforces.
 *   - An empty-string push key is treated the same as a null/missing key:
 *     rejected (never matches a stored key).
 *   - Duplicate keys landing in different parts of the same multi-part
 *     `replace` load are only detected at the `last` part, and discard the
 *     whole load with `400` at that point (rather than failing the
 *     offending part early).
 */

export interface FakeTableDefinition {
  id?: string;
  name?: string;
  columns: SchemaColumn[];
  /** Defaults to 50000 (guide §7), overridable in tests. */
  maxRowsPerRequest?: number;
  /** Defaults to a random key. */
  pushKey?: string;
}

export interface FakeTableHandle {
  tableId: string;
  tableUrl: string;
  pushKey: string;
}

export type InjectedFault = "401" | "404" | "400" | "500" | "dropBefore" | "dropAfter" | { type: "delay"; ms: number };

export interface FakePlanometryServerOptions {
  /** Defaults to 0 (ephemeral). */
  port?: number;
  /** Injectable clock for the 60-minute idle-load timeout. */
  now?: () => Date;
}

interface OpenLoad {
  loadId: string;
  /** key -> {row, partIndex} so a cross-part duplicate key can be detected at `last`. */
  entries: Map<string, { row: PlanometryRow; partIndex: number }>;
  partIndex: number;
  /** Cumulative raw row count across every part seen, including resends — not deduped. */
  totalRowsReceived: number;
  hasCrossPartDuplicate: boolean;
  lastTouchedAtMs: number;
}

interface FakeTable {
  id: string;
  name: string;
  pushKey: string;
  columns: SchemaColumn[];
  keyColumns: string[];
  maxRowsPerRequest: number;
  rows: Map<string, PlanometryRow>;
  version: number;
  rowsUpdatedAt: string | null;
  openLoad?: OpenLoad;
}

interface FaultEntry {
  fault: InjectedFault;
  remaining: number;
}

const SUPPORTED_MODES: PushMode[] = ["replace", "upsert", "delete", "realtime"];
const DEFAULT_MAX_ROWS = 50_000;
const LOAD_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export class FakePlanometryServer {
  baseUrl = "";
  private readonly server: Server;
  private readonly tables = new Map<string, FakeTable>();
  private readonly tableIdByKey = new Map<string, string>();
  private readonly faultQueues = new Map<string, FaultEntry[]>();
  private readonly now: () => Date;
  private nextTableId = 1;

  private constructor(server: Server, now: () => Date) {
    this.server = server;
    this.now = now;
  }

  static async start(options: FakePlanometryServerOptions = {}): Promise<FakePlanometryServer> {
    const server = createServer();
    const instance = new FakePlanometryServer(server, options.now ?? (() => new Date()));
    server.on("request", (req, res) => instance.handle(req, res));
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    instance.baseUrl = `http://127.0.0.1:${port}`;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  createTable(def: FakeTableDefinition): FakeTableHandle {
    const id = def.id ?? `ds-fake${this.nextTableId++}`;
    const pushKey = def.pushKey ?? `key-${id}-${Math.random().toString(36).slice(2)}`;
    const keyColumns = def.columns.filter((c) => c.isKey).map((c) => c.name);
    this.tables.set(id, {
      id,
      name: def.name ?? id,
      pushKey,
      columns: def.columns,
      keyColumns,
      maxRowsPerRequest: def.maxRowsPerRequest ?? DEFAULT_MAX_ROWS,
      rows: new Map(),
      version: 0,
      rowsUpdatedAt: null,
    });
    this.tableIdByKey.set(pushKey, id);
    return { tableId: id, tableUrl: `${this.baseUrl}/api/datasources/internal-tables/${id}`, pushKey };
  }

  /** Queues `times` consumptions of `fault` for the next matching requests against this table (FIFO across multiple injectFault calls). */
  injectFault(tableId: string, fault: InjectedFault, times = 1): void {
    const queue = this.faultQueues.get(tableId) ?? [];
    queue.push({ fault, remaining: times });
    this.faultQueues.set(tableId, queue);
  }

  /** Test introspection: a copy of the table's live rows. */
  getRows(tableId: string): PlanometryRow[] {
    const table = this.tables.get(tableId);
    return table ? [...table.rows.values()].map((row) => ({ ...row })) : [];
  }

  /** Test introspection: the open multi-part replace load, if any. */
  getOpenLoad(tableId: string): { loadId: string; loadRowsReceived: number; rows: PlanometryRow[] } | undefined {
    const load = this.tables.get(tableId)?.openLoad;
    if (!load) return undefined;
    return { loadId: load.loadId, loadRowsReceived: load.totalRowsReceived, rows: [...load.entries.values()].map((e) => ({ ...e.row })) };
  }

  getVersion(tableId: string): number | undefined {
    return this.tables.get(tableId)?.version;
  }

  /** Test helper for schema-drift scenarios (`job test`, slice A2): mutates a table's `columns`/`keyColumns` in place, as if the operator had changed the target schema in Planometry after the job was added. */
  updateTableSchema(tableId: string, update: { columns?: SchemaColumn[]; keyColumns?: string[] }): void {
    const table = this.tables.get(tableId);
    if (!table) throw new Error(`no fake table with id ${tableId}`);
    if (update.columns) table.columns = update.columns;
    if (update.keyColumns) table.keyColumns = update.keyColumns;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = /^\/api\/datasources\/internal-tables\/([^/]+)(\/schema)?$/.exec(url.pathname);
      if (!match?.[1]) {
        sendEnvelope(res, 404, { success: false, message: "not found" });
        return;
      }
      const urlTableId = match[1];
      const isSchema = match[2] !== undefined;

      const key = bearerToken(req.headers.authorization);
      const resolvedTableId = key ? this.tableIdByKey.get(key) : undefined;
      if (!key || !resolvedTableId) {
        sendEnvelope(res, 401, { success: false, message: "wrong or regenerated key, or the table was deleted" });
        return;
      }
      if (resolvedTableId !== urlTableId) {
        sendEnvelope(res, 404, { success: false, message: "the table id in the URL does not match this key" });
        return;
      }
      const table = this.tables.get(resolvedTableId);
      if (!table) {
        sendEnvelope(res, 404, { success: false, message: "table not found" });
        return;
      }

      const fault = await this.applyFault(table.id, req, res);
      if (fault === "handled") return;

      if (req.method === "GET" && !isSchema) {
        sendEnvelope(res, 200, { success: true, data: { status: "ok", dataSourceId: table.id, dataSourceName: table.name, serverTime: this.now().toISOString() } });
        return;
      }

      if (req.method === "GET" && isSchema) {
        sendEnvelope(res, 200, {
          success: true,
          data: {
            dataSourceId: table.id,
            dataSourceName: table.name,
            columns: table.columns,
            keyColumns: table.keyColumns,
            supportedModes: SUPPORTED_MODES,
            maxRowsPerRequest: table.maxRowsPerRequest,
            rowCount: table.rows.size,
            rowsUpdatedAt: table.rowsUpdatedAt,
            version: table.version,
          },
        });
        return;
      }

      if (req.method === "POST" && !isSchema) {
        const body = await readBody(req);
        this.handlePush(table, body, res, fault);
        return;
      }

      sendEnvelope(res, 404, { success: false, message: "not found" });
    } catch (err) {
      sendEnvelope(res, 400, { success: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Pops and applies the next queued fault for this table, if any. Returns "handled" if the request is fully disposed of (terminal fault, response already sent), "dropAfter" if the request should be applied normally but the response dropped, or "none". */
  private async applyFault(tableId: string, req: IncomingMessage, res: ServerResponse): Promise<"handled" | "dropAfter" | "none"> {
    const queue = this.faultQueues.get(tableId);
    const entry = queue?.[0];
    if (!entry) return "none";

    const consume = () => {
      entry.remaining -= 1;
      if (entry.remaining <= 0) queue!.shift();
    };

    const fault = entry.fault;
    if (typeof fault === "object" && fault.type === "delay") {
      consume();
      await new Promise((resolve) => setTimeout(resolve, fault.ms));
      return "none";
    }
    if (fault === "dropBefore") {
      consume();
      req.socket.destroy();
      return "handled";
    }
    if (fault === "dropAfter") {
      consume();
      return "dropAfter";
    }
    // 401/404/400/500: terminal responses, consumed and sent immediately.
    consume();
    const status = Number(fault);
    sendEnvelope(res, status, { success: false, message: `fault injected: ${fault}` });
    return "handled";
  }

  private handlePush(table: FakeTable, body: PushRequestBody, res: ServerResponse, faultState: "none" | "dropAfter"): void {
    try {
      const result = applyPush(table, body, this.now);
      if (faultState === "dropAfter") {
        res.destroy();
        return;
      }
      sendEnvelope(res, 200, { success: true, data: result });
    } catch (err) {
      if (err instanceof PushValidationError) {
        sendEnvelope(res, 400, { success: false, message: err.message });
        return;
      }
      throw err;
    }
  }
}

class PushValidationError extends Error {}

function applyPush(table: FakeTable, body: PushRequestBody, now: () => Date) {
  const mode = body.mode;
  if (!SUPPORTED_MODES.includes(mode)) throw new PushValidationError(`mode not supported by this table: ${String(mode)}`);

  const rows = body.rows ?? [];
  const deleted = body.deleted ?? [];
  if (rows.length + deleted.length > table.maxRowsPerRequest) {
    throw new PushValidationError(`more than ${table.maxRowsPerRequest} rows (rows + deleted) in one request`);
  }

  for (const row of rows) validateRow(table, row);
  for (const row of deleted) validateRow(table, row);

  switch (mode) {
    case "upsert":
      return applyUpsert(table, rows);
    case "delete":
      return applyDelete(table, deleted.length ? deleted : rows);
    case "realtime":
      return applyRealtime(table, rows, deleted);
    case "replace":
      return body.loadId ? applyReplacePart(table, body, now) : applyReplaceWhole(table, rows);
  }
}

function validateRow(table: FakeTable, row: PlanometryRow): void {
  const columnByName = new Map(table.columns.map((c) => [c.name, c]));
  for (const name of Object.keys(row)) {
    if (!columnByName.has(name)) throw new PushValidationError(`unknown column '${name}'`);
  }
  for (const keyColumn of table.keyColumns) {
    const value = row[keyColumn];
    if (value === null || value === undefined) throw new PushValidationError(`empty key column '${keyColumn}'`);
  }
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    const column = columnByName.get(name);
    if (column && !valueFitsType(value, column.type)) throw new PushValidationError(`bad cell for column '${name}' (expected ${column.type})`);
  }
}

function valueFitsType(value: unknown, type: ColumnType): boolean {
  switch (type) {
    case "Text":
      return true;
    case "Number":
      return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
    case "Date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "DateTime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "Boolean":
      return (
        typeof value === "boolean" ||
        value === 0 ||
        value === 1 ||
        (typeof value === "string" && ["yes", "no"].includes(value.toLowerCase()))
      );
  }
}

function rowKey(table: Pick<FakeTable, "keyColumns">, row: PlanometryRow): string {
  return JSON.stringify(table.keyColumns.map((k) => row[k]));
}

function bumpVersion(table: FakeTable): number {
  table.version += 1;
  table.rowsUpdatedAt = new Date().toISOString();
  return table.version;
}

function applyUpsert(table: FakeTable, rows: PlanometryRow[]) {
  const deduped = new Map<string, PlanometryRow>();
  for (const row of rows) deduped.set(rowKey(table, row), row);
  for (const [key, row] of deduped) table.rows.set(key, row);
  const version = bumpVersion(table);
  return { mode: "upsert" as const, status: "completed" as const, rowCount: table.rows.size, rowsAffected: deduped.size, version, completedAt: table.rowsUpdatedAt! };
}

function applyDelete(table: FakeTable, rows: PlanometryRow[]) {
  const keys = new Set(rows.map((row) => rowKey(table, row)));
  let removed = 0;
  for (const key of keys) {
    if (table.rows.delete(key)) removed += 1;
  }
  const version = bumpVersion(table);
  return { mode: "delete" as const, status: "completed" as const, rowCount: table.rows.size, rowsAffected: removed, version, completedAt: table.rowsUpdatedAt! };
}

function applyRealtime(table: FakeTable, rows: PlanometryRow[], deleted: PlanometryRow[]) {
  const upsertDeduped = new Map<string, PlanometryRow>();
  for (const row of rows) upsertDeduped.set(rowKey(table, row), row);
  for (const [key, row] of upsertDeduped) table.rows.set(key, row);

  const deleteKeys = new Set(deleted.map((row) => rowKey(table, row)));
  let removed = 0;
  for (const key of deleteKeys) {
    if (table.rows.delete(key)) removed += 1;
  }

  const version = bumpVersion(table);
  return {
    mode: "realtime" as const,
    status: "completed" as const,
    rowCount: table.rows.size,
    rowsAffected: upsertDeduped.size + removed,
    rowsDeleted: removed,
    version,
    completedAt: table.rowsUpdatedAt!,
  };
}

function applyReplaceWhole(table: FakeTable, rows: PlanometryRow[]) {
  const deduped = new Map<string, PlanometryRow>();
  for (const row of rows) deduped.set(rowKey(table, row), row);
  table.rows = deduped;
  const version = bumpVersion(table);
  return { mode: "replace" as const, status: "completed" as const, rowCount: table.rows.size, rowsAffected: table.rows.size, version, completedAt: table.rowsUpdatedAt! };
}

function applyReplacePart(table: FakeTable, body: PushRequestBody, now: () => Date) {
  const loadId = body.loadId!;
  const nowMs = now().getTime();

  const idleExpired = table.openLoad && nowMs - table.openLoad.lastTouchedAtMs > LOAD_IDLE_TIMEOUT_MS;
  if (!table.openLoad || table.openLoad.loadId !== loadId || idleExpired) {
    table.openLoad = { loadId, entries: new Map(), partIndex: 0, totalRowsReceived: 0, hasCrossPartDuplicate: false, lastTouchedAtMs: nowMs };
  }
  const load = table.openLoad;
  load.partIndex += 1;
  load.lastTouchedAtMs = nowMs;

  const rows = body.rows ?? [];
  load.totalRowsReceived += rows.length;

  const partDeduped = new Map<string, PlanometryRow>();
  for (const row of rows) partDeduped.set(rowKey(table, row), row);
  for (const [key, row] of partDeduped) {
    const existing = load.entries.get(key);
    if (existing && existing.partIndex !== load.partIndex) load.hasCrossPartDuplicate = true;
    load.entries.set(key, { row, partIndex: load.partIndex });
  }

  if (!body.last) {
    return { mode: "replace" as const, status: "accepted" as const, loadId, loadRowsReceived: load.totalRowsReceived };
  }

  if (body.totalRows !== undefined && body.totalRows !== load.totalRowsReceived) {
    table.openLoad = undefined;
    throw new PushValidationError(`totalRows mismatch: expected ${body.totalRows}, received ${load.totalRowsReceived}`);
  }
  if (load.hasCrossPartDuplicate) {
    table.openLoad = undefined;
    throw new PushValidationError("duplicate key across different parts of the same replace load");
  }

  table.rows = new Map([...load.entries].map(([key, e]) => [key, e.row]));
  table.openLoad = undefined;
  const version = bumpVersion(table);
  return { mode: "replace" as const, status: "completed" as const, rowCount: table.rows.size, rowsAffected: table.rows.size, version, completedAt: table.rowsUpdatedAt!, loadId };
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function sendEnvelope(res: ServerResponse, status: number, body: { success: boolean; message?: string; data?: unknown }): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<PushRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const isGzip = (req.headers["content-encoding"] ?? "").includes("gzip");
  const text = (isGzip ? gunzipSync(raw) : raw).toString("utf8");
  return text ? (JSON.parse(text) as PushRequestBody) : ({} as PushRequestBody);
}
