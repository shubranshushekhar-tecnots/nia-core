import { statfs } from "node:fs/promises";

/**
 * Free-disk-space pre-flight (Phase 2 §4: "Check free disk space before
 * starting; fail clearly if insufficient") — checked before opening any
 * DB connection, against a conservative worst-case: enough room for a
 * few max-size chunk files in flight at once (extract can spool faster
 * than the upload drains, especially retrying against a slow link).
 */
export const DEFAULT_MIN_FREE_BYTES = 4 * 16 * 1024 * 1024; // 4 chunk files worth, headroom for in-flight + one retry

export class InsufficientDiskSpaceError extends Error {
  constructor(
    public readonly dir: string,
    public readonly freeBytes: number,
    public readonly requiredBytes: number,
  ) {
    super(`insufficient free disk space in ${dir}: ${freeBytes} bytes free, ${requiredBytes} required`);
  }
}

/** Throws `InsufficientDiskSpaceError` if `dir`'s filesystem has less than `minFreeBytes` available. `dir` must already exist. */
export async function assertDiskSpace(dir: string, minFreeBytes = DEFAULT_MIN_FREE_BYTES): Promise<void> {
  const stats = await statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes < minFreeBytes) {
    throw new InsufficientDiskSpaceError(dir, freeBytes, minFreeBytes);
  }
}
