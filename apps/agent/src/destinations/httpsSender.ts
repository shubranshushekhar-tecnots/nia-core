import { request } from "undici";

/**
 * Task item 2: sign-in methods for the generic HTTPS destination.
 * Secrets (bearer token / API key value / basic password) are resolved
 * by the caller from the local encrypted store and passed in as
 * `secret` — never logged, never embedded in an error message here.
 */
export type HttpsAuthMethod = "none" | "bearer" | "apiKey" | "basic";

export interface HttpsAuthConfig {
  method: HttpsAuthMethod;
  /** "bearer" -> the token; "apiKey" -> the key value; "basic" -> the password. Unused for "none". */
  secret?: string;
  /** "apiKey" only — the header name the secret is sent under. */
  headerName?: string;
  /** "basic" only — non-secret. */
  username?: string;
}

export interface HttpsBatchRequest {
  url: string;
  rows: unknown[];
  /** Unset sends a bare JSON array; set sends `{ [rowsField]: rows }`. */
  rowsField?: string;
  auth: HttpsAuthConfig;
  /** Fixed by the caller for this batch, including across every retry/resend of it — never regenerated mid-retry. */
  batchId: string;
  runNumber: number;
  batchNumber: number;
  isLastBatch: boolean;
  signal?: AbortSignal;
}

export type HttpsBatchOutcome =
  | { outcome: "sent" }
  /** Any 4xx other than 429 — task item 2: "stops the run and pauses the job", no retry. */
  | { outcome: "stopAndPause"; reason: string }
  /** Network error, 5xx, or 429, with all 5 attempts exhausted — retryable by the scheduler on its own schedule, no pause. */
  | { outcome: "failed"; reason: string };

const MAX_ATTEMPTS = 5;
/** Deliberately much smaller than planometry/client.ts's 1s base — keeps the two required tests (which exercise every retry) fast; this module has its own, independent backoff budget. */
const RETRY_BASE_MS = 20;
const REQUEST_TIMEOUT_MS = 60_000;

function buildAuthHeaders(auth: HttpsAuthConfig): Record<string, string> {
  switch (auth.method) {
    case "none":
      return {};
    case "bearer":
      return { authorization: `Bearer ${auth.secret}` };
    case "apiKey":
      return { [(auth.headerName ?? "x-api-key").toLowerCase()]: auth.secret ?? "" };
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.secret ?? ""}`, "utf8").toString("base64")}` };
  }
}

/** `Retry-After` as either a number of seconds or an HTTP date (both valid per RFC 9110 §10.2.3). */
function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one batch, retrying in place (same `batchId`/headers every
 * attempt — a resend after a lost response is just this loop's next
 * attempt, task item 2's "a resend uses the same batch id"). Network
 * errors, 5xx and 429 (honouring `Retry-After`) retry up to
 * `MAX_ATTEMPTS`; any other 4xx stops immediately with no retry.
 */
export async function sendHttpsBatch(req: HttpsBatchRequest): Promise<HttpsBatchOutcome> {
  const body = req.rowsField ? JSON.stringify({ [req.rowsField]: req.rows }) : JSON.stringify(req.rows);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-nia-batch-id": req.batchId,
    "x-nia-run-number": String(req.runNumber),
    "x-nia-batch-number": String(req.batchNumber),
    "x-nia-last-batch": req.isLastBatch ? "true" : "false",
    ...buildAuthHeaders(req.auth),
  };

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await request(req.url, { method: "POST", signal: controller.signal, headers, body });
      const statusCode = res.statusCode;
      await res.body.text().catch(() => undefined);

      if (statusCode >= 200 && statusCode < 300) return { outcome: "sent" };

      if (statusCode === 429 || statusCode >= 500) {
        lastError = `destination returned ${statusCode}`;
        if (attempt < MAX_ATTEMPTS) {
          const retryAfterMs = statusCode === 429 ? parseRetryAfterMs(res.headers["retry-after"] as string | undefined) : undefined;
          await sleep(retryAfterMs ?? RETRY_BASE_MS * attempt);
          continue;
        }
        return { outcome: "failed", reason: lastError };
      }

      // Any other 4xx (e.g. 400/401/403/404): stop and pause, never retried.
      return { outcome: "stopAndPause", reason: `destination returned ${statusCode}` };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      return { outcome: "failed", reason: lastError };
    } finally {
      clearTimeout(timer);
    }
  }
  return { outcome: "failed", reason: lastError };
}
