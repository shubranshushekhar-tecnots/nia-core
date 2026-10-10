/** Shared constants for the Electron shell -- kept in one place so main.ts, window.ts, and tray/trayManager.ts agree. */

export const APP_DISPLAY_NAME = "Nia Core Agent";

/** How often the tray polls GET /status. */
export const STATUS_POLL_INTERVAL_MS = 15_000;

/** How often the "service isn't running" screen retries on its own, with no user action. */
export const AUTO_RETRY_INTERVAL_MS = 5_000;

/** Re-mint the OTC/session proactively on window show/focus once the last mint is this old --
 * half of sessionStore.ts's 12h sliding session TTL, so a session is refreshed well before it
 * could ever expire while the window just sits open/backgrounded. */
export const PROACTIVE_REMINT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Default window size for a first run (no saved windowState.json yet). */
export const DEFAULT_WINDOW_WIDTH = 1180;
export const DEFAULT_WINDOW_HEIGHT = 780;

/** Internal marker URL used by the "service isn't running" screen's Retry link/button -- caught by
 * window.ts's will-navigate handler before it ever reaches navigationGuard, never a real navigation. */
export const RETRY_MARKER_URL = "app://retry";
