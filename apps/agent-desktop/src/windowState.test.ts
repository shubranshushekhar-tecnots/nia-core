import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampBoundsToDisplays, loadWindowBounds, saveWindowBounds } from "./windowState.js";

describe("loadWindowBounds / saveWindowBounds", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-agent-desktop-test-"));
    filePath = path.join(dir, "window-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the default size when the file doesn't exist", () => {
    expect(loadWindowBounds(filePath)).toEqual({ width: 1180, height: 780 });
  });

  it("returns the default size when the file is corrupt JSON", () => {
    fs.writeFileSync(filePath, "{not json");
    expect(loadWindowBounds(filePath)).toEqual({ width: 1180, height: 780 });
  });

  it("returns the default size when width/height are an implausibly tiny saved size", () => {
    fs.writeFileSync(filePath, JSON.stringify({ width: 10, height: 10, x: 0, y: 0 }));
    expect(loadWindowBounds(filePath)).toEqual({ width: 1180, height: 780 });
  });

  it("round-trips a saved size + position", () => {
    saveWindowBounds(filePath, { width: 1400, height: 900, x: 50, y: 60 });
    expect(loadWindowBounds(filePath)).toEqual({ width: 1400, height: 900, x: 50, y: 60 });
  });

  it("round-trips a saved size with no position", () => {
    saveWindowBounds(filePath, { width: 1400, height: 900 });
    expect(loadWindowBounds(filePath)).toEqual({ width: 1400, height: 900 });
  });
});

describe("clampBoundsToDisplays", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };

  it("keeps a position that overlaps a connected display", () => {
    const bounds = { width: 1180, height: 780, x: 100, y: 100 };
    expect(clampBoundsToDisplays(bounds, [primary])).toEqual(bounds);
  });

  it("drops the position (keeps only size) when no display overlaps it", () => {
    const bounds = { width: 1180, height: 780, x: 5000, y: 5000 };
    expect(clampBoundsToDisplays(bounds, [primary])).toEqual({ width: 1180, height: 780 });
  });

  it("passes through a bounds with no position unchanged", () => {
    const bounds = { width: 1180, height: 780 };
    expect(clampBoundsToDisplays(bounds, [primary])).toEqual(bounds);
  });

  it("checks against every connected display, not just the first", () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 1024 };
    const bounds = { width: 1180, height: 780, x: 2000, y: 100 };
    expect(clampBoundsToDisplays(bounds, [primary, secondary])).toEqual(bounds);
  });
});
