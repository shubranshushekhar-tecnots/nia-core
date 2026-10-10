/**
 * Set to `true` only by an explicit Quit (tray menu "Quit" or the app's own "before-quit" event,
 * e.g. Cmd+Q on macOS) *before* `app.quit()` is called -- window.ts's `close` handler checks this to
 * tell "the user clicked X" (hide to tray, background service keeps syncing) apart from "the user
 * asked to quit" (let the window actually close so the app can exit).
 */
export const quitState = { isQuitting: false };
