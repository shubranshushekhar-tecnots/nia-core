import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { enableStartAtLoginByDefault } from "./autoLaunch.js";
import { APP_DISPLAY_NAME } from "./constants.js";
import { quitState } from "./quitState.js";
import { handleSecondInstance, shouldQuitForSecondInstance } from "./singleInstance.js";
import { TrayManager } from "./tray/trayManager.js";
import { MainWindow } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "..", "assets");
const appIconPath = path.join(assetsDir, "app-icon.png");

app.setName(APP_DISPLAY_NAME);

const gotLock = app.requestSingleInstanceLock();
if (shouldQuitForSecondInstance(gotLock)) {
  // Another instance already holds the lock -- it just received "second-instance" and will focus
  // its own window. This process must exit immediately without creating a second window/tray icon.
  app.quit();
} else {
  let mainWindow: MainWindow | null = null;
  let tray: TrayManager | null = null;

  app.on("second-instance", () => handleSecondInstance(mainWindow?.win ?? null));

  app.on("activate", () => {
    // macOS: clicking the Dock icon when the window is hidden-to-tray should reopen it, same as
    // the tray's "Open Nia Core Agent" item.
    if (mainWindow) handleSecondInstance(mainWindow.win);
  });

  app.on("before-quit", () => {
    quitState.isQuitting = true;
    tray?.destroy();
  });

  app.whenReady().then(async () => {
    const userDataDir = app.getPath("userData");
    const firstRunMarker = path.join(userDataDir, "first-run-complete");
    if (!fs.existsSync(firstRunMarker)) {
      enableStartAtLoginByDefault(app);
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(firstRunMarker, "1");
    }

    const windowStatePath = path.join(userDataDir, "window-state.json");
    mainWindow = new MainWindow(windowStatePath, appIconPath);

    tray = new TrayManager({
      assetsDir,
      loginItemApi: app,
      onOpen: () => void mainWindow?.open(),
      onQuit: () => {
        quitState.isQuitting = true;
        app.quit();
      },
    });

    await mainWindow.open();
  });
}
