/**
 * Graceful shutdown (Phase 2 §7): SIGINT/SIGTERM aborts `controller`,
 * which the main loop threads through as the `signal` on in-flight
 * `streamExtract`/chunk-upload calls (see sync/runSync.ts) — those paths
 * already report the run failed and clean up the spool on abort, so this
 * module's only job is translating the OS signal into that one
 * `AbortSignal`, once, and running an optional callback (e.g. flushing
 * logs) before the process exits.
 */
export function installGracefulShutdown(controller: AbortController, onShutdown?: () => void | Promise<void>): () => void {
  let triggered = false;
  const handler = () => {
    if (triggered) return;
    triggered = true;
    controller.abort();
    void onShutdown?.();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
