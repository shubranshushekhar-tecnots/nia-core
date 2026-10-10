import fs from "node:fs";
import { DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH } from "./constants.js";

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };

/** Returns the default size (no position) if the file is missing, corrupt, or has an implausible size -- never throws. */
export function loadWindowBounds(filePath: string): WindowBounds {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return DEFAULT_BOUNDS;
    if (parsed.width < 400 || parsed.height < 300) return DEFAULT_BOUNDS;
    const bounds: WindowBounds = { width: parsed.width, height: parsed.height };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      bounds.x = parsed.x;
      bounds.y = parsed.y;
    }
    return bounds;
  } catch {
    return DEFAULT_BOUNDS;
  }
}

export function saveWindowBounds(filePath: string, bounds: WindowBounds): void {
  fs.writeFileSync(filePath, JSON.stringify(bounds));
}

/**
 * If the saved position no longer overlaps any connected display (e.g. an external monitor was
 * unplugged), drop the position and let Electron center the window on the primary display instead
 * of restoring it fully off-screen and unreachable.
 */
export function clampBoundsToDisplays(bounds: WindowBounds, displays: DisplayBounds[]): WindowBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const onAnyDisplay = displays.some(
    (d) => bounds.x! + bounds.width > d.x && bounds.x! < d.x + d.width && bounds.y! + bounds.height > d.y && bounds.y! < d.y + d.height,
  );
  if (onAnyDisplay) return bounds;
  return { width: bounds.width, height: bounds.height };
}
