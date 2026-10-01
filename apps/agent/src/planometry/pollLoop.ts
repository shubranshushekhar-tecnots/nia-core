import type { PlanometryClient } from "./client.js";
import type { WorkItem } from "./types.js";

export interface PollLoopOptions {
  client: PlanometryClient;
  connectionId: string;
  onWork: (work: WorkItem) => Promise<void>;
  /** Called after every poll, whether or not it returned work (Phase 3b §3: "agent status" per-connection "last poll" state). */
  onPoll?: () => void;
  /** +/- fraction of `pollAfterSeconds` applied as jitter, so GMS's several connections don't poll in lockstep (Phase 2 §4). */
  jitterFraction?: number;
  signal: AbortSignal;
}

/** Polls `GET /v1/work`, honoring `pollAfterSeconds` (+ jitter) between empty polls, until `signal` aborts. */
export async function runPollLoop(options: PollLoopOptions): Promise<void> {
  const jitterFraction = options.jitterFraction ?? 0.2;
  while (!options.signal.aborted) {
    const response = await options.client.pollWork(options.connectionId);
    options.onPoll?.();
    if (response.work) {
      await options.onWork(response.work);
      continue;
    }
    await sleep(jitteredDelayMs(response.pollAfterSeconds, jitterFraction), options.signal);
  }
}

export function jitteredDelayMs(pollAfterSeconds: number, jitterFraction: number): number {
  const base = pollAfterSeconds * 1000;
  const jitter = base * jitterFraction * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
