import { RunStreamEnvelope } from '@nia/schemas';

/**
 * Browser-side calls for Phase 6 Block 3 execution. Both hit the same
 * cookie-authenticated `/api/backend/:path*` rewrite as chatClient.ts (not
 * the Bearer-auth pattern previewClient.ts/checksClient.ts use) — see
 * apps/api/src/routes/runs.ts's header comment: GET .../run/stream is
 * consumed via EventSource, which can never attach a custom Authorization
 * header, only same-origin cookies, and POST .../run is kept on the same
 * cookie-authed router so both halves of "start a run, then stream it"
 * share one consistent auth story.
 */

export class RunApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RunApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Block 5 (multi-destination fan-out): `destNodeIds` is a non-empty array —
 * each destination gets its own independent runId (see apps/api/src/
 * services/runs.ts's startWorkflowRun). Callers stream each returned
 * `runId` separately via streamRun below.
 */
export async function startWorkflowRun(
  workflowId: string,
  destNodeIds: string[],
): Promise<{ runs: { destNodeId: string; runId: string }[] }> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ destNodeIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new RunApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.json() as Promise<{ runs: { destNodeId: string; runId: string }[] }>;
}

/**
 * Block 3.5 item 3 — cooperative cancel. Fire-and-forget from the UI's
 * perspective: the actual stop happens between chunks in the worker
 * (runEtl.ts's checkpoint poll), surfaced back to the caller as a `cancel`
 * stream event on the same run/stream this function doesn't touch.
 */
export async function cancelWorkflowRun(workflowId: string, runId: string): Promise<void> {
  const res = await fetch(`/api/backend/workflows/${workflowId}/run/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ runId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new RunApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
}

/**
 * Opens the SSE stream for one run and wires it to the given callbacks.
 * Returns a teardown function the caller MUST invoke on unmount / before
 * opening a new stream — mirrors chatClient.ts's streamChat() exactly,
 * including its no-auto-retry rationale (a terminal event always closes
 * the connection itself; a transport-level error surfaces once via
 * onTransportError for a manual retry instead of blind reconnection).
 */
export function streamRun(
  workflowId: string,
  runId: string,
  handlers: {
    onEvent: (event: RunStreamEnvelope['event'], seq: number) => void;
    onTransportError: () => void;
  },
  options?: {
    afterSeq?: number;
  },
): () => void {
  const params = new URLSearchParams({ runId });
  if (options?.afterSeq !== undefined) params.set('after', String(options.afterSeq));
  const source = new EventSource(`/api/backend/workflows/${workflowId}/run/stream?${params.toString()}`);
  let closed = false;
  let gotTerminalEvent = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return; // malformed frame — drop, don't crash the stream
    }
    const result = RunStreamEnvelope.safeParse(parsed);
    if (!result.success) return;
    const { seq, event } = result.data;
    if (event.type === 'done' || event.type === 'error' || event.type === 'cancel') {
      gotTerminalEvent = true;
    }
    handlers.onEvent(event, seq);
    if (gotTerminalEvent) teardown();
  };

  source.onerror = () => {
    if (gotTerminalEvent || closed) return; // benign: fires after our own teardown() in some browsers
    teardown();
    handlers.onTransportError();
  };

  return teardown;
}
