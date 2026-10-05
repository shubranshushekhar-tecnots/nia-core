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
}

/** One shared instance per process — every route handler imports this same bus. */
export const taskBus = new TaskBus();
