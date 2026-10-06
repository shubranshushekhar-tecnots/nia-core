import fs from "node:fs/promises";
import path from "node:path";

/**
 * Agent downloads: one server-side setting (`AGENT_DOWNLOADS_BASE_URL`)
 * decides where the three installer packages and `manifest.json` come
 * from. Unset (local dev) → read straight from apps/agent/packaging's
 * per-platform `dist/` folders, served by the dev-only route at
 * app/api/agent-downloads/[file]/route.ts. Set (production) → both the
 * manifest and the files themselves are fetched from that address, which
 * in production points at the folder deploy/nginx/nginx.conf serves
 * directly (see DEPLOYMENT.md "Agent downloads").
 */

export type AgentOs = "windows" | "macos" | "linux";

export type DownloadManifestFile = {
  name: string;
  os: AgentOs;
  kind: "primary" | "advanced";
  size: number;
  sha256: string;
};

export type DownloadManifest = {
  version: string;
  generatedAt: string;
  files: DownloadManifestFile[];
};

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

export function getDownloadsBaseUrl(): string | undefined {
  return process.env.AGENT_DOWNLOADS_BASE_URL || undefined;
}

export async function getDownloadManifest(): Promise<DownloadManifest> {
  const base = getDownloadsBaseUrl();
  if (base) {
    const res = await fetch(`${base.replace(/\/$/, "")}/manifest.json`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`failed to fetch agent download manifest: ${res.status}`);
    }
    return (await res.json()) as DownloadManifest;
  }
  const raw = await fs.readFile(path.join(PACKAGING_ROOT, "manifest.json"), "utf8");
  return JSON.parse(raw) as DownloadManifest;
}

export function getDownloadUrl(file: DownloadManifestFile): string {
  const base = getDownloadsBaseUrl();
  if (base) return `${base.replace(/\/$/, "")}/${file.name}`;
  return `/api/agent-downloads/${file.name}`;
}
