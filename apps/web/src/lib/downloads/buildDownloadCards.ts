import type { AgentOs, DownloadManifestFile } from "./manifest";

/**
 * Pulled out of components/downloads/DownloadsPage.tsx so the "download
 * page lists the three packages with the size and checksum from the
 * manifest" test (Part 3) can exercise the exact grouping/display logic
 * directly, without rendering JSX (this repo's vitest.config.ts only runs
 * plain .ts modules today — see its comment).
 */
export type DownloadCard = {
  os: AgentOs;
  primary: DownloadManifestFile;
  advanced?: DownloadManifestFile;
};

export const AGENT_OS_ORDER: AgentOs[] = ["windows", "macos", "linux"];

export function buildDownloadCards(
  files: DownloadManifestFile[],
  order: AgentOs[] = AGENT_OS_ORDER,
): DownloadCard[] {
  const primaryByOs = new Map<AgentOs, DownloadManifestFile>();
  const advancedByOs = new Map<AgentOs, DownloadManifestFile>();
  for (const file of files) {
    if (file.kind === "primary") primaryByOs.set(file.os, file);
    else advancedByOs.set(file.os, file);
  }

  const cards: DownloadCard[] = [];
  for (const os of order) {
    const primary = primaryByOs.get(os);
    if (!primary) continue;
    cards.push({ os, primary, advanced: advancedByOs.get(os) });
  }
  return cards;
}
