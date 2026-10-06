import path from "node:path";
import { getAgentDistDir, type DownloadManifest, type DownloadManifestFile } from "./manifest";

/**
 * Pulled out of the route handler (app/api/agent-downloads/[file]/route.ts)
 * so Part 3's "refuses a file name that is not in the manifest, including
 * a path that tries to leave the folder" test can exercise the refusal
 * logic directly, without booting a Next server.
 */
export class DownloadNotAllowedError extends Error {}

export function resolveManifestFile(
  manifest: DownloadManifest,
  requestedName: string,
): DownloadManifestFile {
  // Refuse anything that isn't a bare file name before even looking at the
  // manifest — Next's single dynamic segment can't itself carry a literal
  // "/", but a decoded "..%2f.." or a literal ".." must still be refused
  // explicitly rather than relying on that alone.
  if (
    requestedName.length === 0 ||
    requestedName.includes("/") ||
    requestedName.includes("\\") ||
    requestedName.includes("..")
  ) {
    throw new DownloadNotAllowedError(`refused: not a plain file name: ${requestedName}`);
  }
  const entry = manifest.files.find((file) => file.name === requestedName);
  if (!entry) {
    throw new DownloadNotAllowedError(`refused: not listed in manifest: ${requestedName}`);
  }
  return entry;
}

export function resolveAgentFilePath(entry: DownloadManifestFile): string {
  const distDir = path.resolve(getAgentDistDir(entry.os));
  const resolved = path.resolve(distDir, entry.name);
  if (resolved !== path.join(distDir, entry.name) || !resolved.startsWith(distDir + path.sep)) {
    throw new DownloadNotAllowedError(`refused: resolves outside dist dir: ${entry.name}`);
  }
  return resolved;
}
