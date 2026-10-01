/**
 * Fires `onHeartbeat` whenever `markActivity()` hasn't been called for
 * `intervalMs` (DECIDED: 60s — Phase 2 §4). Used by the sync executor both
 * before the first chunk (slow query/view, no rows yet) and between chunks
 * (large extract with a gap exceeding the interval). Any successful
 * Planometry call for the run — a chunk push, or the heartbeat call itself
 * — should call `markActivity()` to reset the window.
 */
export class HeartbeatScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly onHeartbeat: () => void | Promise<void>,
  ) {}

  start(): void {
    this.scheduleNext();
  }

  markActivity(): void {
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.onHeartbeat();
      this.scheduleNext();
    }, this.intervalMs);
  }
}
