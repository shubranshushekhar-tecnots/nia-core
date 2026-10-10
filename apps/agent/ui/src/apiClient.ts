/**
 * Thin fetch wrapper against the agent's `/ui/api/*` session-authed
 * mirror of its local control API (see apps/agent/src/localApi/uiProxyRoutes.ts)
 * -- cookies travel automatically (same-origin), so the real bearer
 * token is never read, stored, or sent by this file. Every mutating
 * call sets `X-Nia-UI: 1` (the CSRF defense router.ts requires for
 * `auth: "session"` POST/DELETE routes). `exchangeOtcForSession` is the
 * one exception that talks to `/ui/session` directly (not under
 * `/ui/api`, `auth: "none"`) -- see main.tsx's bootstrap.
 */

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

type SessionExpiredListener = () => void;
let sessionExpiredListeners: SessionExpiredListener[] = [];

/** Subscribed once by App.tsx to show a global "session expired" banner. Returns an unsubscribe function. */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.push(listener);
  return () => {
    sessionExpiredListeners = sessionExpiredListeners.filter((l) => l !== listener);
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (method === "POST" || method === "DELETE") headers["X-Nia-UI"] = "1";
  if (init?.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";

  const res = await fetch(`/ui/api${path}`, { ...init, method, headers });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);

  if (!res.ok) {
    const kind = (body as { kind?: string } | undefined)?.kind ?? "internal";
    const message = (body as { message?: string } | undefined)?.message ?? "request failed";
    if (res.status === 401 && kind === "sessionExpired") {
      for (const listener of sessionExpiredListeners) listener();
    }
    throw new ApiClientError(res.status, kind, message);
  }
  return body as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/** `POST /ui/session` -- the one call in this file that is not under `/ui/api` and needs no session yet (`auth: "none"`). */
export async function exchangeOtcForSession(otc: string): Promise<void> {
  const res = await fetch("/ui/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ otc }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { kind?: string; message?: string } | undefined;
    throw new ApiClientError(res.status, body?.kind ?? "otcInvalid", body?.message ?? "That code has expired or already been used.");
  }
}

// ---- status ----

export type JobRunResult = "completed" | "failed" | "skipped";

export interface JobErrorInfo {
  class: string;
  message: string;
  at: string;
}

export interface JobPauseInfo {
  reason: string;
  at: string;
}

export interface JobState {
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastResult?: JobRunResult;
  lastError?: JobErrorInfo;
  lastConsoleMessage?: string;
  consecutiveFailures: number;
  paused?: JobPauseInfo;
  nextRunAt?: string;
  rowsSent?: number;
  durationMs?: number;
}

/** Surfaced whenever `UpdateChecker` has detected a newer build (Phase 6 polish). `undefined` once up to date / never checked. */
export interface PendingUpdate {
  version: string;
  /** True once downloaded + checksum-verified but install was deliberately deferred (e.g. needs elevation) -- show "click to finish installing". */
  readyToInstall: boolean;
}

interface StatusResponseBase {
  agentVersion: string;
  startedAt?: string;
  uptimeSeconds?: number;
  jobs: Record<string, JobState>;
  pendingUpdate?: PendingUpdate;
}

export type StatusResponse =
  | (StatusResponseBase & { paired: false })
  | (StatusResponseBase & {
      paired: true;
      platformUrl: string;
      agentId: string;
      online: boolean;
      lastCheckInAt?: string;
      revoked: boolean;
    });

export function getStatus(): Promise<StatusResponse> {
  return request<StatusResponse>("/status");
}

// ---- auto-update ----

export interface AutoUpdateSettings {
  enabled: boolean;
}

export function getAutoUpdateSettings(): Promise<AutoUpdateSettings> {
  return request<AutoUpdateSettings>("/update/settings");
}

export function setAutoUpdateSettings(enabled: boolean): Promise<AutoUpdateSettings> {
  return postJson<AutoUpdateSettings>("/update/settings", { enabled });
}

export type CheckForUpdateResult = { triggered: true } | { triggered: false; reason: string };

/** Triggers one `UpdateChecker.tick()` immediately. `triggered:false` whenever unpaired (no live checker). */
export function checkForUpdateNow(): Promise<CheckForUpdateResult> {
  return postJson<CheckForUpdateResult>("/update/check", {});
}

// ---- pairing ----

export interface PairResult {
  agentId: string;
}

export function pair(code: string, url?: string): Promise<PairResult> {
  return postJson<PairResult>("/pair", { code, url });
}

// ---- server discovery (Windows only -- always [] elsewhere) ----

export interface WindowsSqlInstance {
  name: string;
  instanceId: string;
  port?: number;
  tcpEnabled: boolean;
  /** Registry `LoginMode` DWORD: 1 = Windows-only, 2 = Mixed. */
  loginMode?: number;
}

export function listServers(): Promise<{ instances: WindowsSqlInstance[] }> {
  return request("/servers");
}

// ---- SQL login testing ----

export type SqlLoginFailureKind =
  | "wrongCredentials"
  | "windowsAuthOnly"
  | "unreachable"
  | "wrongPortOrInstance"
  | "tlsCertUntrusted"
  | "tlsProtocolTooOld"
  | "databaseNotFound"
  | "unknown";

export type SqlLoginTestResult = { ok: true; databases: string[] } | { ok: false; reason: string; kind: SqlLoginFailureKind };

export interface SqlLoginInput {
  host: string;
  instanceName?: string;
  port?: number;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  allowLegacyTls?: boolean;
}

export type TestConnectionResult = SqlLoginTestResult & { autoTrustedCertificate: boolean; autoAllowedLegacyTls: boolean };

export function testConnection(input: SqlLoginInput, pickedInstanceLoginMode?: number): Promise<TestConnectionResult> {
  return postJson("/connections/test", { ...input, pickedInstanceLoginMode });
}

export function listDatabasesForConnection(connectionId: string): Promise<SqlLoginTestResult> {
  return request(`/databases?connectionId=${encodeURIComponent(connectionId)}`);
}

export function listDatabasesRaw(input: SqlLoginInput): Promise<SqlLoginTestResult> {
  return postJson("/databases/list", input);
}

// ---- saved connections ----

export interface SqlServerConnectionConfig {
  host: string;
  port?: number;
  instanceName?: string;
  database: string;
  encrypt?: boolean;
  allowLegacyTls?: boolean;
  trustServerCertificate?: boolean;
}

export interface ConnectionEntry {
  id: string;
  label: string;
  sqlserver: SqlServerConnectionConfig;
  sourceTimeZone: string;
  credentialRef: string;
}

export interface AddConnectionInput {
  id: string;
  label: string;
  host: string;
  port?: number;
  instanceName?: string;
  database: string;
  user: string;
  password: string;
  encrypt?: boolean;
  allowLegacyTls?: boolean;
  trustServerCertificate?: boolean;
  sourceTimeZone: string;
}

export function saveConnection(input: AddConnectionInput): Promise<ConnectionEntry> {
  return postJson("/connections", input);
}

export function listConnections(): Promise<{ connections: ConnectionEntry[] }> {
  return request("/connections");
}

export function deleteConnection(id: string): Promise<{ removed: true }> {
  return del(`/connections/${encodeURIComponent(id)}`);
}

// ---- table browsing (read-only; no "tables to share" concept exists in this API) ----

export interface TableSummary {
  schema: string;
  table: string;
  kind: "table" | "view";
  rowCount: number | null;
}

export type ExtractType = "text" | "number" | "date" | "datetime" | "boolean";

export interface CatalogColumn {
  name: string;
  type: ExtractType;
  nullable: boolean;
}

export interface TablePreview {
  columns: CatalogColumn[];
  rows: Record<string, string | number | boolean | null>[];
}

export function listTables(connectionId: string): Promise<{ tables: TableSummary[] }> {
  return request(`/connections/${encodeURIComponent(connectionId)}/tables`);
}

export function listColumns(connectionId: string, table: string): Promise<{ columns: CatalogColumn[] }> {
  return request(`/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/columns`);
}

export function previewTable(connectionId: string, table: string, limit?: number): Promise<TablePreview> {
  const qs = limit ? `?limit=${limit}` : "";
  return request(`/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(table)}/preview${qs}`);
}

// ---- destinations allow-list ----

export function listDestinations(): Promise<{ hosts: string[] }> {
  return request("/destinations");
}

export function addDestination(host: string): Promise<{ host: string }> {
  return postJson("/destinations", { host });
}

export function removeDestination(host: string): Promise<{ removed: true }> {
  return del(`/destinations/${encodeURIComponent(host)}`);
}

// ---- logs ----

export interface ParsedLogLine {
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

export function getLogs(params: { level?: "info" | "warn" | "error"; search?: string; since?: string } = {}): Promise<{ entries: ParsedLogLine[] }> {
  const query = new URLSearchParams();
  if (params.level) query.set("level", params.level);
  if (params.search) query.set("search", params.search);
  if (params.since) query.set("since", params.since);
  const qs = query.toString();
  return request(`/logs${qs ? `?${qs}` : ""}`);
}

/** Cookie is sent automatically (same-origin) -- no query token needed, unlike the bearer-only `/logs/stream`. Returns an unsubscribe function. */
export function streamLogs(onLine: (line: ParsedLogLine) => void): () => void {
  const source = new EventSource("/ui/api/logs/stream");
  source.onmessage = (event) => {
    try {
      onLine(JSON.parse(event.data) as ParsedLogLine);
    } catch {
      // Not a parseable log line -- ignore rather than crash the stream.
    }
  };
  return () => source.close();
}

// ---- diagnostics ----

export interface DiagnosticsResponse {
  agentVersion: string;
  platform: string;
  status: { startedAt?: string; uptimeSeconds?: number; jobs: Record<string, JobState> };
  config: {
    connections: ConnectionEntry[];
    jobs: unknown[];
    destinations: string[];
    link?: { platformUrl: string; agentId: string };
  };
  logs: string[];
}

export function getDiagnostics(): Promise<DiagnosticsResponse> {
  return request("/diagnostics");
}

// ---- workflows ----

/** Bridge-reported statuses, plus the agent-local-only "running" overlay (localApi/routes/workflows.ts). */
export type WorkflowStatus = "ok" | "failing" | "paused" | "rejected" | "waiting";
export type LocalWorkflowStatus = WorkflowStatus | "running";

export interface WorkflowLastRun {
  status: "ok" | "failed";
  finishedAt: string;
  rowsSent: number;
  errorClass: string | null;
}

export interface WorkflowSummary {
  workflowId: string;
  setupId: string;
  name: string;
  status: LocalWorkflowStatus;
  errorClass: string | null;
  rejectionReason: string | null;
  nextRunAt: string | null;
  lastRun: WorkflowLastRun | null;
}

export interface WorkflowRun {
  id: string;
  runId: string;
  status: "ok" | "failed";
  rowsSent: number;
  rowsDeleted: number;
  mode: string | null;
  durationMs: number;
  errorClass: string | null;
  startedAt: string;
  finishedAt: string;
}

export type SanitizedGraphNodeType = "source" | "transform" | "destination";

export interface SanitizedGraphNode {
  id: string;
  type: SanitizedGraphNodeType;
  position: { x: number; y: number };
  manifestName: string | null;
  connectionLabel: string | null;
  region: string | null;
  entityLabel: string | null;
  writeModeLabel: string | null;
  resolved: boolean;
  unknownReason: string | null;
}

export interface SanitizedGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface SanitizedGraph {
  workflowId: string;
  version: number;
  nodes: SanitizedGraphNode[];
  edges: SanitizedGraphEdge[];
}

export interface WorkflowActionBody {
  kind: "run_now" | "pause" | "resume";
  params?: Record<string, string>;
  fullReload?: boolean;
}

export function listWorkflows(): Promise<{ workflows: WorkflowSummary[]; offline: boolean }> {
  return request("/workflows");
}

export function getWorkflow(workflowId: string): Promise<{ workflow: WorkflowSummary; platformUrl?: string; offline: boolean }> {
  return request(`/workflows/${encodeURIComponent(workflowId)}`);
}

export function listWorkflowRuns(workflowId: string, limit?: number): Promise<{ runs: WorkflowRun[]; offline: boolean }> {
  const qs = limit ? `?limit=${limit}` : "";
  return request(`/workflows/${encodeURIComponent(workflowId)}/runs${qs}`);
}

export function getWorkflowGraph(workflowId: string): Promise<{ graph: SanitizedGraph; offline: boolean }> {
  return request(`/workflows/${encodeURIComponent(workflowId)}/graph`);
}

export function postWorkflowAction(workflowId: string, body: WorkflowActionBody): Promise<{ ok: true }> {
  return postJson(`/workflows/${encodeURIComponent(workflowId)}/actions`, body);
}
