import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUiAssetsMap } from "./seaAssets.mjs";

describe("packaging/shared/seaAssets.buildUiAssetsMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sea-assets-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps every file to its forward-slash-relative path, keyed exactly as staticAssets.ts's loadUiAsset looks it up", () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
    mkdirSync(path.join(dir, "fonts", "satoshi"), { recursive: true });
    writeFileSync(path.join(dir, "fonts", "satoshi", "satoshi-400.woff2"), "fake-font-bytes");

    const assets = buildUiAssetsMap(dir);

    expect(Object.keys(assets).sort()).toEqual(["assets/index-abc123.js", "fonts/satoshi/satoshi-400.woff2", "index.html"].sort());
    expect(assets["index.html"]).toBe(path.join(dir, "index.html"));
    expect(assets["assets/index-abc123.js"]).toBe(path.join(dir, "assets", "index-abc123.js"));
    expect(assets["fonts/satoshi/satoshi-400.woff2"]).toBe(path.join(dir, "fonts", "satoshi", "satoshi-400.woff2"));
  });

  it("returns an empty map for an empty directory", () => {
    expect(buildUiAssetsMap(dir)).toEqual({});
  });
});
