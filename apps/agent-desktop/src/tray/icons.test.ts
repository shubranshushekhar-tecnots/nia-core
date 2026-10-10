import path from "node:path";
import { describe, expect, it } from "vitest";
import { nextFrame, trayIconFileName, trayIconPath } from "./icons.js";

describe("trayIconFileName", () => {
  it("resolves static states to a Template PNG on macOS", () => {
    expect(trayIconFileName("idle", { platform: "darwin" })).toBe("nia-idle-16Template.png");
    expect(trayIconFileName("off", { platform: "darwin" })).toBe("nia-off-16Template.png");
  });

  it("resolves static states to a plain (non-template) PNG on Windows/Linux", () => {
    expect(trayIconFileName("idle", { platform: "win32" })).toBe("nia-idle-16.png");
    expect(trayIconFileName("off", { platform: "linux" })).toBe("nia-off-16.png");
  });

  it("never includes 'Template' in the Windows/Linux name", () => {
    expect(trayIconFileName("idle", { platform: "win32" })).not.toMatch(/template/i);
  });

  it("resolves a specific syncing/starting frame with zero-padded index", () => {
    expect(trayIconFileName("syncing", { platform: "darwin", frame: 3 })).toBe("nia-sync-f03-16Template.png");
    expect(trayIconFileName("starting", { platform: "win32", frame: 8 })).toBe("nia-start-f08-16.png");
  });

  it("omits the frame suffix when no frame is given", () => {
    expect(trayIconFileName("syncing", { platform: "darwin" })).toBe("nia-sync-16Template.png");
  });

  it("uses the non-template lightbar/darkbar variant for 'problem' on macOS", () => {
    expect(trayIconFileName("problem", { platform: "darwin" })).toBe("nia-problem-lightbar-16.png");
    expect(trayIconFileName("problem", { platform: "darwin", darkMode: true })).toBe("nia-problem-darkbar-16.png");
  });

  it("uses a single flat 'problem' icon on Windows/Linux (no lightbar/darkbar split)", () => {
    expect(trayIconFileName("problem", { platform: "win32" })).toBe("nia-problem-16.png");
  });

  it("respects a custom base size", () => {
    expect(trayIconFileName("idle", { platform: "win32", size: 32 })).toBe("nia-idle-32.png");
  });
});

describe("trayIconPath", () => {
  it("joins the assets dir with the platform/state subfolders and resolved file name", () => {
    expect(trayIconPath("/assets", "idle", { platform: "darwin" })).toBe(
      path.join("/assets", "tray", "macos", "idle", "nia-idle-16Template.png"),
    );
    expect(trayIconPath("/assets", "problem", { platform: "win32" })).toBe(
      path.join("/assets", "tray", "windows-linux", "problem", "nia-problem-16.png"),
    );
    expect(trayIconPath("/assets", "syncing", { platform: "darwin", frame: 1 })).toBe(
      path.join("/assets", "tray", "macos", "sync", "nia-sync-f01-16Template.png"),
    );
  });
});

describe("nextFrame", () => {
  it("advances 1-based frames and wraps back to 1 after frameCount", () => {
    expect(nextFrame(1, 8)).toBe(2);
    expect(nextFrame(7, 8)).toBe(8);
    expect(nextFrame(8, 8)).toBe(1);
  });
});
