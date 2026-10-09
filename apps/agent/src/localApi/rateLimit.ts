/**
 * Tiny fixed-window counter -- not keyed by IP, since the server only
 * ever binds `127.0.0.1` (one caller: the desktop app on the same
 * machine). Applied to `POST /pair` and `POST /connections/test`,
 * both brute-force-sensitive (a pairing code or a database password).
 */
export class RateLimiter {
  private windowStart = Date.now();
  private hits = 0;

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {}

  /** Returns `true` and records a hit if under the limit for the current window; `false` (no hit recorded) once over it. */
  tryHit(now = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.hits = 0;
    }
    if (this.hits >= this.maxHits) return false;
    this.hits += 1;
    return true;
  }
}
