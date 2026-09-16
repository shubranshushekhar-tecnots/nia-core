import type { Request, Response } from "express";
import { Redis } from "ioredis";
import { env } from "../env.js";

/** Handle passed into an SSE route's body so it can push events and check liveness. */
export interface SseController {
  /** True once the connection is closing/closed — callers should stop doing work and return. */
  readonly closed: boolean;
  /** Aborts when the connection closes for any reason (client disconnect, timeout, normal completion). */
  readonly signal: AbortSignal;
  send(data: unknown): void;
}

function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Generic SSE lifecycle: headers, a dedicated AbortSignal callers can race
 * against (e.g. a Redis subscription's message loop), a periodic
 * comment-only heartbeat so intermediary proxies don't kill an idle
 * connection, a hard max-duration timeout that force-emits `onTimeout`'s
 * event and closes rather than holding the connection (and whatever
 * resource the caller opened, e.g. a Redis subscriber) open forever, and a
 * try/finally around `run` so `onClose` always fires exactly once — client
 * abort, normal completion, or timeout all funnel through the same close()
 * path.
 */
export async function runSse(
  req: Request,
  res: Response,
  options: {
    run: (controller: SseController) => Promise<void>;
    onTimeout: () => unknown;
    heartbeatMs?: number;
    maxDurationMs?: number;
  },
): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? env.CHAT_SSE_HEARTBEAT_MS;
  const maxDurationMs = options.maxDurationMs ?? env.CHAT_SSE_MAX_DURATION_MS;

  // No compression middleware is mounted anywhere in apps/api (see
  // index.ts) — verified, not just assumed, since a compress stream would
  // buffer this response and defeat the point of flushHeaders below.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx-in-front-of-this dev convenience: never buffer SSE
  });
  // Node does NOT actually send HTTP response headers on writeHead() alone —
  // they're held until the first res.write(). Without an explicit flush, a
  // client's fetch()/EventSource "connection open" only resolves once the
  // first real event happens to be written, which silently conflates
  // "stream is open" with "first pipeline event fired" — this is exactly
  // what made the Phase 4 latency probe's numbers look like a ~4s connect
  // delay when the real cause was partly this buffering, partly the
  // subscribe race subscribeWithReplay below fixes. Flushing immediately
  // and writing a throwaway comment as byte one makes "connection open"
  // true connection-open time, independent of pipeline timing.
  res.flushHeaders();
  res.write(": connected\n\n");

  let closed = false;
  const abortController = new AbortController();

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearTimeout(maxDurationTimer);
    abortController.abort();
    try {
      res.end();
    } catch {
      // Already closed (e.g. client disconnected) — ignore.
    }
  }

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    res.write(": heartbeat\n\n");
  }, heartbeatMs);

  const maxDurationTimer = setTimeout(() => {
    if (closed) return;
    res.write(sseLine(options.onTimeout()));
    close();
  }, maxDurationMs);

  req.on("close", close); // client aborted / navigated away

  const controller: SseController = {
    get closed() {
      return closed;
    },
    signal: abortController.signal,
    send(data: unknown) {
      if (closed) return;
      res.write(sseLine(data));
    },
  };

  try {
    await options.run(controller);
  } finally {
    close();
  }
}

/** The {seq, ts, event} shape every replay-backed publisher writes — kept generic (no chat-specific fields) so other SSE routes (e.g. Phase 5's Logs) can reuse subscribeWithReplay against their own channel/listKey. */
export interface ReplayEnvelope<E = unknown> {
  seq: number;
  ts: number;
  event: E;
}

/**
 * Generic replay-capable Redis pub/sub consumer for an SSE route. Chat-
 * agnostic on purpose — it only knows about a channel string, a Redis LIST
 * key holding the same {seq,ts,event} envelopes RPUSH'd alongside every
 * PUBLISH, and a caller-supplied terminal-event predicate. Any future
 * SSE route with the same "durable log + live pub/sub" publish pattern
 * (Logs, Phase 5) can reuse this unchanged.
 *
 * Ordering guarantee: subscribes to live pub/sub FIRST (buffering
 * everything that arrives, not yet emitting), THEN LRANGEs the full
 * persisted log and emits it in order, THEN drains whatever arrived live
 * during that window (deduped against the replay by `seq`), THEN goes
 * fully live. A client connecting at any point — including after the job
 * has already finished, within the log's TTL — gets the complete ordered
 * sequence exactly once, with no gap and no duplicate.
 *
 * `afterSeq` (GET /chat/stream's `?after=`) skips anything already seen —
 * the reconnect-resume path: replay + live events with `seq <= afterSeq`
 * are silently dropped by the same dedup check that prevents double
 * delivery.
 */
export async function subscribeWithReplay<E = unknown>(
  redisUrl: string,
  options: {
    channel: string;
    listKey: string;
    afterSeq?: number;
    onEnvelope: (envelope: ReplayEnvelope<E>) => void;
    isTerminal: (event: E) => boolean;
    signal: AbortSignal;
  },
): Promise<void> {
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const commandClient = new Redis(redisUrl, { maxRetriesPerRequest: null });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let done = false;
      let maxSeqSent = options.afterSeq ?? -1;
      let buffering = true;
      const liveBuffer: ReplayEnvelope<E>[] = [];

      function emit(envelope: ReplayEnvelope<E>): void {
        if (done) return;
        if (envelope.seq <= maxSeqSent) return; // already delivered — replay/live dedup
        maxSeqSent = envelope.seq;
        options.onEnvelope(envelope);
        if (options.isTerminal(envelope.event)) {
          done = true;
          finish();
        }
      }

      options.signal.addEventListener("abort", finish, { once: true });

      subscriber.on("message", (receivedChannel, raw) => {
        if (receivedChannel !== options.channel) return;
        let envelope: ReplayEnvelope<E>;
        try {
          envelope = JSON.parse(raw);
        } catch {
          // Reserved non-JSON sentinel (e.g. a future forced-close signal) —
          // never forwarded to the client, matches the original SSE route's
          // "__close" handling.
          done = true;
          finish();
          return;
        }
        if (buffering) {
          liveBuffer.push(envelope);
        } else {
          emit(envelope);
        }
      });

      (async () => {
        try {
          await new Promise<void>((res, rej) => {
            subscriber.subscribe(options.channel, (err) => (err ? rej(err) : res()));
          });

          const rawList = await commandClient.lrange(options.listKey, 0, -1);
          for (const raw of rawList) {
            if (done) break;
            try {
              emit(JSON.parse(raw));
            } catch {
              // malformed replay entry — skip, don't crash the stream
            }
          }

          buffering = false;
          const buffered = liveBuffer.splice(0);
          for (const envelope of buffered) {
            if (done) break;
            emit(envelope);
          }

          if (done) finish();
        } catch (err) {
          settled = true;
          reject(err);
        }
      })();
    });
  } finally {
    await subscriber.unsubscribe(options.channel).catch(() => undefined);
    subscriber.disconnect();
    commandClient.disconnect();
  }
}
