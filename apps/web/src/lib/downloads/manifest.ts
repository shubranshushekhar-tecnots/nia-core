import path from "node:path";
import {
  getDownloadsBaseUrl,
  loadDownloadManifest,
  type AgentOs,
  type DownloadManifest,
  type DownloadManifestFile,
} from "@nia/schemas";

/**
 * Agent downloads: one server-side setting (`AGENT_DOWNLOADS_BASE_URL`)
 * decides where the three installer packages and `manifest.json` come
 * from. Unset (local dev) → read straight from apps/agent/packaging's
 * per-platform `dist/` folders, served by the dev-only route at
 * app/api/agent-downloads/[file]/route.ts. Set (production) → both the
 * manifest and the files themselves are fetched from that address, which
 * in production points at the folder deploy/nginx/nginx.conf serves
 * directly (see DEPLOYMENT.md "Agent downloads"). The manifest shape and
 * base-url/local-fallback load logic itself live in @nia/schemas
 * (downloadManifest.ts) — shared with services/agent-bridge's
 * `GET /agent-api/update` route (Phase 6 polish) — this file keeps only
 * what's specific to apps/web: resolving the local dist dirs and the
 * dev-route-vs-base-url download URL.
 */

export type { AgentOs, DownloadManifest, DownloadManifestFile };
export { getDownloadsBaseUrl };

// apps/web's own cwd at runtime is apps/web/ (both `next dev` and the
// standalone server.js), so ../agent/packaging reaches apps/agent/packaging
// in this monorepo checkout — the same relative hop used nowhere else
// in apps/web today because no other feature reaches across apps/ at
// runtime; downloads is the first.
export const PACKAGING_ROOT = path.join(process.cwd(), "..", "agent", "packaging");

const OS_DIST_DIR: Record<AgentOs, string> = {
  windows: path.join(PACKAGING_ROOT, "windows", "dist"),
  macos: path.join(PACKAGING_ROOT, "macos", "dist"),
  linux: path.join(PACKAGING_ROOT, "linux", "dist"),
};

export function getAgentDistDir(os: AgentOs): string {
  return OS_DIST_DIR[os];
}

export async function getDownloadManifest(): Promise<DownloadManifest> {
  return loadDownloadManifest(PACKAGING_ROOT);
}

export function getDownloadUrl(file: DownloadManifestFile): string {
  const base = getDownloadsBaseUrl();
  if (base) return `${base.replace(/\/$/, "")}/${file.name}`;
  return `/api/agent-downloads/${file.name}`;
}
