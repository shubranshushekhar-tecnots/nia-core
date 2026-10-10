import path from "node:path";
import { describe, expect, it } from "vitest";
import { trayIconFileName, trayIconPath } from "./icons.js";

describe("trayIconFileName", () => {
  it("maps each connection color to its own plain (non-template) PNG", () => {
    expect(trayIconFileName("green")).toBe("tray-green.png");
    expect(trayIconFileName("amber")).toBe("tray-amber.png");
    expect(trayIconFileName("grey")).toBe("tray-grey.png");
  });

  it("never includes 'Template' in the name, which would make macOS strip the color", () => {
    expect(trayIconFileName("green")).not.toMatch(/template/i);
  });
});

describe("trayIconPath", () => {
  it("joins the assets dir with the resolved file name", () => {
    expect(trayIconPath("/assets", "green")).toBe(path.join("/assets", "tray-green.png"));
  });
});
