import { EventEmitter } from "node:events";

/**
 * Slice C1 (point 1 of the approved plan) — in-process coordination
 * between three things happening concurrently in this one Fastify
 * process: a held /agent-api/check-in waiting for new tasks, the internal
 * /test or /introspect handler waiting for a specific task's result, and
 * the /agent-api/task-results route that the agent eventually posts to.
 *
 * Purely in-memory — fine for a single bridge instance; if this service
 * is ever scaled horizontally, a held check-in on instance A and a task
 * created by instance B would need a shared pub/sub (e.g. Postgres
 * LISTEN/NOTIFY or Redis) instead. Out of scope for this slice.
 */
class TaskBus extends EventEmitter {
  /** Called right after a task row is inserted for `agentId` — wakes any check-in currently held for that agent so it returns immediately instead of waiting out its hold. */
  wakeAgent(agentId: string): void {
    this.emit(`wake:${agentId}`, undefined);
  }

  /** Resolves (or rejects on timeout) once `/agent-api/task-results` reports `taskId` done/failed, or `timeoutMs` elapses first — whichever comes first, so a route handler waiting on this never hangs past its own per-kind budget. */
  async awaitTaskResult(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ status: "done" | "failed"; result?: unknown; errorClass?: string }> {
    return new Promise((resolve, reject) => {
      const event = `result:${taskId}`;
      const timer = setTimeout(() => {
        this.removeListener(event, onResult);
        reject(new Error("timed out waiting for the agent's task result"));
      }, timeoutMs);
      const onResult = (payload: { status: "done" | "failed"; result?: unknown; errorClass?: string }) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.once(event, onResult);
    });
  }

  /** Called by the /agent-api/task-results route once a task's outcome is durably stored. */
  resolveTaskResult(taskId: string, payload: { status: "done" | "failed"; result?: unknown; errorClass?: string }): void {
    this.emit(`result:${taskId}`, payload);
  }

  /** Lets a held check-in wait for "a new task showed up for me" without polling, raced by the caller against its own remaining hold time. */
  waitForWake(agentId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const event = `wake:${agentId}`;
      const timer = setTimeout(() => {
        this.removeListener(event, onWake);
        resolve();
      }, timeoutMs);
      const onWake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once(event, onWake);
    });
  }

  /**
   * Slice T2 (plan point 2) — the same wait/resolve/timeout shape as
   * awaitTaskResult/resolveTaskResult above, but keyed by a read-ahead
   * batch's cache key (readAheadCache.ts) instead of a taskId: /execute
   * creates at most one read_batch task per cache miss, then waits here
   * for the dedicated upload route (app.ts) to store the FIRST batch —
   * woken in-process the instant it lands, no Redis round-trip needed for
   * the waiter itself (the batch is also durably written to Redis, for
   * correctness and for every batch after the first).
   */
  async awaitBatch(cacheKey: string, timeoutMs: number): Promise<{ ok: true; batch: unknown } | { ok: false; errorClass?: string }> {
    return new Promise((resolve, reject) => {
      const event = `batch:${cacheKey}`;
      const timer = setTimeout(() => {
        this.removeListener(event, onBatch);
        reject(new Error("timed out waiting for the agent's read batch"));
      }, timeoutMs);
      const onBatch = (payload: { ok: true; batch: unknown } | { ok: false; errorClass?: string }) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.once(event, onBatch);
    });
  }

  /** Called by the dedicated upload route once a batch is durably cached. */
  resolveBatch(cacheKey: string, batch: unknown): void {
    this.emit(`batch:${cacheKey}`, { ok: true, batch });
  }

  /**
   * Called when the read_batch task itself fails or is reported done
   * without ever producing the awaited batch (e.g. the agent is stopped
   * mid-read) — lets a pending /execute fail promptly with a clear message
   * instead of hanging out its own timeout (plan point 5's "cancel ...
   * never a hang").
   */
  rejectBatch(cacheKey: string, errorClass?: string): void {
    this.emit(`batch:${cacheKey}`, { ok: false, errorClass });
  }
}

/** One shared instance per process — every route handler imports this same bus. */
export const taskBus = new TaskBus();
