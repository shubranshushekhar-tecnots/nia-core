import path from "node:path";
import type { ConnectionColor } from "./statusState.js";

/**
 * Resolves a tray icon's absolute path for a given connection color.
 * Windows/Linux use a plain, full-color PNG per state (a small colored dot)
 * -- deliberately NOT using Electron/macOS's "template image" convention
 * (any file with "Template" in its name is auto-tinted to monochrome by the
 * OS), since that would strip out exactly the green/amber/grey color coding
 * that tray relies on there.
 *
 * macOS instead always shows the same monochrome Nia glyph (auto-recolored
 * by the OS for light/dark menu bars via the "Template" filename
 * convention) -- connection state is conveyed via the disabled status menu
 * line (see trayManager.ts), not icon color, matching macOS menu-bar icon
 * conventions. Only "amber" (a real connection problem, vs. "grey" = simply
 * not paired/connected yet) swaps in the badged "problem" variant.
 */
export function trayIconFileName(color: ConnectionColor, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return color === "amber" ? "trayTemplateProblem.png" : "trayTemplate.png";
  }
  return `tray-${color}.png`;
}

export function trayIconPath(assetsDir: string, color: ConnectionColor, platform: NodeJS.Platform = process.platform): string {
  return path.join(assetsDir, trayIconFileName(color, platform));
}
