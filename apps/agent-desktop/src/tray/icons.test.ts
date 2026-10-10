import path from "node:path";
import { describe, expect, it } from "vitest";
import { trayIconFileName, trayIconPath } from "./icons.js";

describe("trayIconFileName", () => {
  it("maps each connection color to its own plain (non-template) PNG on Windows/Linux", () => {
    expect(trayIconFileName("green", "win32")).toBe("tray-green.png");
    expect(trayIconFileName("amber", "win32")).toBe("tray-amber.png");
    expect(trayIconFileName("grey", "win32")).toBe("tray-grey.png");
    expect(trayIconFileName("green", "linux")).toBe("tray-green.png");
  });

  it("never includes 'Template' in the Windows/Linux name, which would make macOS strip the color", () => {
    expect(trayIconFileName("green", "win32")).not.toMatch(/template/i);
  });

  it("uses the monochrome template glyph on macOS, badged only for amber (a real problem)", () => {
    expect(trayIconFileName("green", "darwin")).toBe("trayTemplate.png");
    expect(trayIconFileName("grey", "darwin")).toBe("trayTemplate.png");
    expect(trayIconFileName("amber", "darwin")).toBe("trayTemplateProblem.png");
  });
});

describe("trayIconPath", () => {
  it("joins the assets dir with the resolved file name", () => {
    expect(trayIconPath("/assets", "green", "win32")).toBe(path.join("/assets", "tray-green.png"));
    expect(trayIconPath("/assets", "amber", "darwin")).toBe(path.join("/assets", "trayTemplateProblem.png"));
  });
});
