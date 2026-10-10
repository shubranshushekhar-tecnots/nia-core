import path from "node:path";
import type { TrayStateKind } from "./statusState.js";

/**
 * Resolves animated tray icon frame paths for a given TrayState. Assets live in
 * assets/tray/<macos|windows-linux>/<idle|sync|start|problem|off>/ -- copied verbatim
 * from designs/nia-agent-icons/ (see that folder's SPEC.md for frame counts/timings).
 *
 * macOS uses Electron/OS "Template image" filename convention (auto-tinted monochrome,
 * `@2x` siblings auto-selected for HiDPI by nativeImage.createFromPath) for every state
 * except "problem", which instead shows a non-template, colored lightbar/darkbar glyph
 * picked via nativeTheme.shouldUseDarkColors (see trayManager.ts) -- a real connection
 * problem is the one case macOS tray icons deviate from monochrome, matching the design
 * export's intent of making it unmistakable regardless of menu-bar appearance.
 *
 * Windows/Linux use plain full-color PNGs throughout (no Template convention), with a
 * single flat "problem" icon (no lightbar/darkbar split needed off macOS).
 */

const STATE_FOLDER: Record<TrayStateKind, string> = {
  idle: "idle",
  syncing: "sync",
  starting: "start",
  problem: "problem",
  off: "off",
};

const STATE_FILE_STEM: Record<TrayStateKind, string> = {
  idle: "idle",
  syncing: "sync",
  starting: "start",
  problem: "problem",
  off: "off",
};

export const SYNC_FRAME_COUNT = 8;
export const START_FRAME_COUNT = 8;
export const SYNC_FRAME_INTERVAL_MS = 190;
export const START_FRAME_INTERVAL_MS = 110;
export const SYNC_TAIL_MS = 1000;

export interface TrayIconOptions {
  /** 1-based frame index, only meaningful for "syncing"/"starting". */
  frame?: number;
  platform?: NodeJS.Platform;
  /** Base (1x) pixel size to request -- defaults to 16, Electron resolves the `@2x` sibling itself. */
  size?: number;
  /** macOS "problem" icon only: picks the lightbar/darkbar variant. */
  darkMode?: boolean;
}

/** Advances a 1-based frame counter, wrapping back to 1 after frameCount. */
export function nextFrame(current: number, frameCount: number): number {
  return (current % frameCount) + 1;
}

export function trayIconFileName(state: TrayStateKind, options: TrayIconOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const size = options.size ?? 16;
  const isMac = platform === "darwin";

  if (state === "problem") {
    if (isMac) {
      const variant = options.darkMode ? "darkbar" : "lightbar";
      return `nia-problem-${variant}-${size}.png`;
    }
    return `nia-problem-${size}.png`;
  }

  const stem = STATE_FILE_STEM[state];
  const frameSuffix = (state === "syncing" || state === "starting") && options.frame ? `-f${String(options.frame).padStart(2, "0")}` : "";
  return isMac ? `nia-${stem}${frameSuffix}-${size}Template.png` : `nia-${stem}${frameSuffix}-${size}.png`;
}

export function trayIconPath(assetsDir: string, state: TrayStateKind, options: TrayIconOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const platformDir = platform === "darwin" ? "macos" : "windows-linux";
  const stateFolder = STATE_FOLDER[state];
  return path.join(assetsDir, "tray", platformDir, stateFolder, trayIconFileName(state, options));
}
