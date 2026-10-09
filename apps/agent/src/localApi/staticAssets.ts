import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function contentTypeFor(relPath: string): string {
  return CONTENT_TYPES[path.extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * `apps/agent/ui/dist` is always a sibling of this module's own package
 * root (`apps/agent/`), two directories up from wherever this file ends
 * up running from -- `src/localApi/staticAssets.ts` (tsx dev) or
 * `dist/localApi/staticAssets.js` (compiled) both resolve the same way.
 * Not used for a real SEA binary (see `loadUiAsset` below), only for dev
 * and the fs-fallback path.
 */
function uiDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../ui/dist");
}

/**
 * Reads one built UI file, trying the SEA-embedded copy first (Milestone
 * M4: `build-sea.mjs` embeds `apps/agent/ui/dist` via Node's SEA `assets`
 * field, keyed by the same relative path used here) and falling back to
 * a plain `fs.readFileSync` against `uiDistDir()` for every other run
 * mode (`tsx src/index.ts`, `node dist/index.js`, tests). Returns
 * `undefined` if the asset doesn't exist either way -- callers 404.
 */
export async function loadUiAsset(relPath: string): Promise<Buffer | undefined> {
  try {
    const sea = await import("node:sea");
    if (sea.isSea()) {
      try {
        const asset = sea.getAsset(relPath);
        return Buffer.from(asset);
      } catch {
        return undefined;
      }
    }
  } catch {
    // node:sea unavailable (older Node, or not a SEA build) -- fall through to fs.
  }

  const filePath = path.join(uiDistDir(), relPath);
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
}
