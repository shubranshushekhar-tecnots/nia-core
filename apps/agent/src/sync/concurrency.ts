/**
 * Concurrency limits (docs/plans/planometry-integration.md Phase 2 §5):
 * one sync at a time per connection, plus a per-host:port semaphore
 * (default 1 concurrent query per physical SQL Server) so two connections
 * that happen to point at the same server never hammer it concurrently.
 */
export class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** A `Semaphore` per key, created lazily on first use; keys never expire (fixed, small key space: connection ids / host:port pairs). */
export class KeyedSemaphore {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly limit: number) {}

  async acquire(key: string): Promise<() => void> {
    let semaphore = this.semaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(this.limit);
      this.semaphores.set(key, semaphore);
    }
    return semaphore.acquire();
  }
}
