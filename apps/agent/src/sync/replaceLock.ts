import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process lock for a replace load against one target table (docs/
 * plans/planometry-v4-migration.md §10 slice A4, run order step (a)): a
 * second `job run` for the same table while one is already in flight is
 * refused, even across separate `job run` processes — the in-process
 * KeyedSemaphore (sync/concurrency.ts) only protects against concurrent
 * runs within the same process.
 *
 * The lock is a plain JSON file named from the table URL, holding the
 * holder's pid and start time. A lock whose pid is no longer running is
 * stale and is silently taken over (the holder process crashed/was killed
 * without reaching its `finally` cleanup).
 */
export class ReplaceLockTakenError extends Error {
  constructor(
    public readonly tableUrl: string,
    public readonly pid: number,
    public readonly startedAt: string,
  ) {
    super(`a replace run is already in progress for this table (pid ${pid}, started ${startedAt})`);
    this.name = "ReplaceLockTakenError";
  }
}

interface LockFileContents {
  pid: number;
  startedAt: string;
}

function lockFilePathFor(locksDir: string, tableUrl: string): string {
  const safeName = Buffer.from(tableUrl).toString("base64url");
  return path.join(locksDir, `${safeName}.lock.json`);
}

/** `true` if `pid` is a live process (owned by us or another user); `false` only when the OS confirms it no longer exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquires the lock for `tableUrl`, taking over a stale lock (dead pid) if
 * found. Throws `ReplaceLockTakenError` if a live process already holds it.
 * Returns a release function; callers must call it in a `finally` block.
 */
export function acquireReplaceLock(locksDir: string, tableUrl: string, now: () => Date = () => new Date()): () => void {
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const file = lockFilePathFor(locksDir, tableUrl);

  if (fs.existsSync(file)) {
    const existing = readLockFile(file);
    if (existing && isProcessAlive(existing.pid)) {
      throw new ReplaceLockTakenError(tableUrl, existing.pid, existing.startedAt);
    }
    // Stale (dead pid) or unreadable: fall through and take it over.
  }

  const contents: LockFileContents = { pid: process.pid, startedAt: now().toISOString() };
  fs.writeFileSync(file, JSON.stringify(contents), { mode: 0o600 });

  return () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already removed, or never successfully written — nothing to clean up.
    }
  };
}

function readLockFile(file: string): LockFileContents | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockFileContents>;
    if (typeof raw.pid === "number" && typeof raw.startedAt === "string") return raw as LockFileContents;
    return undefined;
  } catch {
    return undefined;
  }
}
