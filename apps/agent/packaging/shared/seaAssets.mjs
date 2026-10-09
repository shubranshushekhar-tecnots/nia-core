// Shared by packaging/{macos,windows}/build-sea.mjs: builds the `assets`
// map Node's `--experimental-sea-config` embeds into the SEA blob, so the
// agent's built-in UI (`apps/agent/ui/dist`) ships inside the single
// executable. Keys MUST be forward-slash relative paths with no leading
// slash -- `staticAssets.ts`'s `loadUiAsset()` looks them up with exactly
// `pathname.replace(/^\/+/, "")` from an incoming URL, which is always
// forward-slash regardless of the OS the SEA binary runs on (and
// regardless of the OS it was *built* on, since `path.sep` on Windows is
// `\\` and would silently produce keys that never match a real request).
import fs from "node:fs";
import path from "node:path";

/**
 * Recursively walks `dir`, returning `{ "relative/posix/path": "/absolute/fs/path" }`
 * for every file under it. `dir` itself is not included as a key.
 */
export function buildUiAssetsMap(dir) {
  const assets = {};
  walk(dir, "");
  return assets;

  function walk(currentDir, relPrefix) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        assets[relPath] = absPath;
      }
    }
  }
}
