import { ChatStreamEnvelope } from '@nia/schemas';

/**
 * Browser-side chat calls. Both hit the same-origin `/api/backend/:path*`
 * rewrite (next.config.mjs), never apps/api's origin directly — the
 * browser's httpOnly Supabase session cookies are attached automatically by
 * the browser on a same-origin request, so unlike chatServer.ts (Server
 * Component side) there's no manual cookie forwarding to do here.
 */

export class ChatApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.code = code;
  }
}

export type PostChatMessageResult = { jobId: string; conversationId: string };

export async function postChatMessage(params: {
  conversationId?: string;
  message: string;
  connectionIds: string[];
}): Promise<PostChatMessageResult> {
  const res = await fetch('/api/backend/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ChatApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<PostChatMessageResult>;
}

/**
 * Opens the SSE stream for one job and wires it to the given callbacks.
 * Returns a teardown function the caller MUST invoke on unmount / before
 * opening a new stream — EventSource does not close itself just because
 * the component that opened it unmounted, and leaving it open after a
 * terminal event (or after the caller navigates away) would keep an idle
 * connection (and its server-side Redis subscriber) alive indefinitely.
 *
 * No auto-retry: EventSource's native onerror fires even after a clean
 * server-side stream close in some browsers, and blindly reconnecting would
 * risk a retry storm against a job that already finished. Terminal events
 * (done/error/refused/conflict) always close the connection themselves via
 * teardown(); a transport-level error (onerror firing before any terminal
 * event arrived) surfaces once via onTransportError so the caller can offer
 * a single manual "Retry" action instead.
 */
export function streamChat(
  jobId: string,
  handlers: {
    onEvent: (event: ChatStreamEnvelope['event'], seq: number) => void;
    onTransportError: () => void;
  },
  options?: {
    // Reconnect-resume: skip everything already delivered up through this
    // seq (see ChatClient.tsx's retry(), which passes the last seq it saw).
    // Absent on a fresh stream, which naturally replays from the start.
    afterSeq?: number;
  },
): () => void {
  const params = new URLSearchParams({ jobId });
  if (options?.afterSeq !== undefined) params.set('after', String(options.afterSeq));
  const source = new EventSource(`/api/backend/chat/stream?${params.toString()}`);
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
    const result = ChatStreamEnvelope.safeParse(parsed);
    if (!result.success) return;
    const { seq, event } = result.data;
    if (event.type === 'done' || event.type === 'error' || event.type === 'refused' || event.type === 'conflict') {
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
