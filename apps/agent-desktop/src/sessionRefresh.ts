import { PROACTIVE_REMINT_INTERVAL_MS } from "./constants.js";

/**
 * The exact text of apps/agent/src/localApi/uiStaticHandler.ts's NO_SESSION_HTML -- served at `/`
 * (instead of the real UI) whenever there's no valid session cookie, e.g. the window landed back
 * on `/` via a plain in-page navigation rather than window.ts's own OTC->session `open()` flow.
 * The same string is also used client-side by the UI's own session-expiry banner
 * (apps/agent/ui/src/App.tsx), so checking for it here catches both: a full-page load of the
 * static fallback, and (redundantly with, not instead of, window.ts's existing 401 interceptor)
 * the SPA's own rendered expiry banner.
 */
export const NO_SESSION_MARKER = "Open Nia Agent again from the Start menu / Applications.";

/** True if `bodyText` (e.g. `document.body.innerText` of the loaded page) is the "no session"
 * fallback page rather than the real agent UI. */
export function isNoSessionPage(bodyText: string): boolean {
  return bodyText.includes(NO_SESSION_MARKER);
}

/** Whether a proactive re-mint is due: `lastMintAt` is `null` (never minted yet) or older than
 * `PROACTIVE_REMINT_INTERVAL_MS`. */
export function shouldProactivelyRemint(lastMintAt: number | null, now: number): boolean {
  if (lastMintAt === null) return true;
  return now - lastMintAt >= PROACTIVE_REMINT_INTERVAL_MS;
}
