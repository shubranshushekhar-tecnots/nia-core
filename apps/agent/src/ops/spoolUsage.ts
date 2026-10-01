import fs from "node:fs";
import path from "node:path";

/**
 * Phase 3b §3: "agent status shows ... spool usage". Read live off disk
 * (not persisted in state.json) since it changes between polls without
 * any state write of its own — spool files are chunk uploads staged
 * briefly during a sync (see sync/spoolWriter.ts), cleaned up once a run
 * reaches a terminal state, so a nonzero value with no sync in flight
 * usually means a crash left orphaned spool files behind.
 */
export interface SpoolUsage {
  bytes: number;
  fileCount: number;
}

export function getSpoolUsage(spoolDir: string): SpoolUsage {
  if (!fs.existsSync(spoolDir)) return { bytes: 0, fileCount: 0 };

  let bytes = 0;
  let fileCount = 0;
  const stack = [spoolDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        fileCount += 1;
      }
    }
  }
  return { bytes, fileCount };
}
