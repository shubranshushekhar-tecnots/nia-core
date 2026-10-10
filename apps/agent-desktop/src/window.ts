import { BrowserWindow, screen, shell } from "electron";
import { defaultHomeDir, readApiToken, readPortFile } from "./agentPaths.js";
import { AgentNotRunningError, buildLaunchUrl, mintOtc } from "./otcLaunch.js";
import { isAllowedNavigation } from "./navigationGuard.js";
import { buildServiceNotRunningDataUrl } from "./errorPage.js";
import { clampBoundsToDisplays, loadWindowBounds, saveWindowBounds } from "./windowState.js";
import { APP_DISPLAY_NAME, RETRY_MARKER_URL } from "./constants.js";
import { quitState } from "./quitState.js";
import { isNoSessionPage, shouldProactivelyRemint } from "./sessionRefresh.js";

/**
 * Owns the single BrowserWindow: loading the OTC → session flow, the "service isn't running"
 * screen, the navigation allow-list, and silent session refresh -- on a 401 from any in-SPA API
 * call, on landing on the server's static "no session" fallback page, and proactively on
 * show/focus once the last mint is stale. See navigationGuard.ts/errorPage.ts/sessionRefresh.ts
 * for the pure logic this wires up.
 */
export class MainWindow {
  readonly win: BrowserWindow;
  private currentPort: number | null = null;
  private lastMintAt: number | null = null;
  private readonly windowStatePath: string;

  constructor(windowStatePath: string, iconPath: string) {
    this.windowStatePath = windowStatePath;
    const saved = loadWindowBounds(windowStatePath);
    const displays = screen.getAllDisplays().map((d) => d.bounds);
    const bounds = clampBoundsToDisplays(saved, displays);

    this.win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      title: APP_DISPLAY_NAME,
      icon: iconPath,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.win.on("close", (event) => {
      if (quitState.isQuitting) return;
      event.preventDefault();
      this.win.hide();
    });

    const persistBounds = (): void => {
      if (this.win.isDestroyed()) return;
      saveWindowBounds(this.windowStatePath, this.win.getBounds());
    };
    this.win.on("resize", persistBounds);
    this.win.on("move", persistBounds);

    this.win.webContents.on("will-navigate", (event, url) => {
      if (url === RETRY_MARKER_URL) {
        event.preventDefault();
        void this.open();
        return;
      }
      if (this.currentPort !== null && isAllowedNavigation(url, this.currentPort)) return;
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    });

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (this.currentPort !== null && isAllowedNavigation(url, this.currentPort)) return { action: "allow" };
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    // Session-expired detection (12h idle): the UI's own apiClient.ts surfaces this as a 401 on any
    // /ui/api/* call once sessionStore.ts's touchSession() rejects a stale cookie. Rather than a
    // preload bridging into that bundle's internal listeners, watch for the same signal at the
    // network level in the main process -- no preload/IPC needed at all.
    this.win.webContents.session.webRequest.onCompleted({ urls: ["http://127.0.0.1:*/*"] }, (details) => {
      if (details.statusCode === 401 && details.url.includes("/ui/api/")) void this.open();
    });

    // Complementary to the 401 interceptor above: catches a full-page navigation that lands
    // directly on the server's static "no session" fallback page (e.g. a bookmark/typed URL, or
    // any in-page link back to `/`) rather than an in-SPA API call failing after the app already
    // rendered. No preload/IPC needed -- executeJavaScript is a privileged main-process call.
    this.win.webContents.on("did-finish-load", () => {
      void this.win.webContents
        .executeJavaScript("document.body ? document.body.innerText : ''")
        .then((text: string) => {
          if (isNoSessionPage(text)) void this.open();
        })
        .catch(() => {});
    });

    // Proactively re-mint well before the session could ever expire, any time the window is
    // brought back to the foreground after sitting open/backgrounded for a while.
    this.win.on("show", () => this.maybeProactiveRemint());
    this.win.on("focus", () => this.maybeProactiveRemint());
  }

  /** No-ops while the offline/error screen is showing -- that screen already auto-retries on its
   * own timer (errorPage.ts), and it calls win.show() too, which would otherwise re-trigger this
   * and loop. currentPort is non-null only after a real successful mint, so checking it first
   * correctly tells "real UI visible, maybe stale" apart from "error screen visible". */
  private maybeProactiveRemint(): void {
    if (this.currentPort === null) return;
    if (shouldProactivelyRemint(this.lastMintAt, Date.now())) void this.open();
  }

  /** Mints a fresh OTC and loads it -- also the "retry" and "session expired -> reload" path. */
  async open(): Promise<void> {
    const dir = defaultHomeDir();
    const portInfo = readPortFile(dir);
    const token = readApiToken(dir);
    if (!portInfo || !token) {
      this.showServiceNotRunning();
      return;
    }
    try {
      const otc = await mintOtc(portInfo.port, token);
      this.currentPort = portInfo.port;
      this.lastMintAt = Date.now();
      await this.win.loadURL(buildLaunchUrl(portInfo.port, otc));
      this.win.show();
    } catch (err) {
      if (err instanceof AgentNotRunningError) {
        this.showServiceNotRunning();
        return;
      }
      throw err;
    }
  }

  private showServiceNotRunning(): void {
    this.currentPort = null;
    void this.win.loadURL(buildServiceNotRunningDataUrl());
    this.win.show();
  }
}
