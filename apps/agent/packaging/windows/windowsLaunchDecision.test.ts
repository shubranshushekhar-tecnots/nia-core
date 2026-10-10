import { describe, expect, it } from "vitest";
import { decideWindowsLaunchMode } from "./windowsLaunchDecision.js";

describe("decideWindowsLaunchMode", () => {
  it("falls back to the browser flow on Windows Server 2012 R2", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 6, minorVersion: 3, buildNumber: 9600 })).toBe("browser");
  });

  it("falls back to the browser flow on Windows 8.1", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 6, minorVersion: 3, buildNumber: 9600 })).toBe("browser");
  });

  it("falls back to the browser flow on Windows 7 / Server 2008 R2", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 6, minorVersion: 1, buildNumber: 7601 })).toBe("browser");
  });

  it("uses the Electron shell on Windows 10", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 10, minorVersion: 0, buildNumber: 19045 })).toBe("electron");
  });

  it("uses the Electron shell on Windows Server 2016 (same majorVersion as Windows 10)", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 10, minorVersion: 0, buildNumber: 14393 })).toBe("electron");
  });

  it("uses the Electron shell on Windows 11", () => {
    expect(decideWindowsLaunchMode({ majorVersion: 10, minorVersion: 0, buildNumber: 22631 })).toBe("electron");
  });
});
