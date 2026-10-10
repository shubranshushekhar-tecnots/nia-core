import path from "node:path";
import type { ConnectionColor } from "./statusState.js";

/**
 * Resolves a tray icon's absolute path for a given connection color. Every platform uses the same
 * plain, full-color PNG per state (a small colored dot) -- deliberately NOT using Electron/macOS's
 * "template image" convention (any file with "Template" in its name is auto-tinted to monochrome by
 * the OS), since that would strip out exactly the green/amber/grey color coding this tray relies on.
 */
export function trayIconFileName(color: ConnectionColor): string {
  return `tray-${color}.png`;
}

export function trayIconPath(assetsDir: string, color: ConnectionColor): string {
  return path.join(assetsDir, trayIconFileName(color));
}
