import { describe, expect, it } from "vitest";
import { buildUiStaticHandler } from "./uiStaticHandler.js";

describe("buildUiStaticHandler", () => {
  it("serves a plain 'open from the Start menu' fallback at / with no session", async () => {
    const handler = buildUiStaticHandler();
    const asset = await handler("/", false);
    expect(asset).toBeDefined();
    expect(asset!.contentType).toContain("text/html");
    expect(asset!.data.toString("utf8")).toContain("Open Nia Core Agent again");
  });

  it("falls back to the same page at / with a valid session if the UI bundle hasn't been built (no apps/agent/ui/dist yet)", async () => {
    // In this repo state apps/agent/ui/dist may or may not exist depending
    // on whether M0's build has been run -- either way this must never
    // throw, and must never silently serve nothing at the app's own entry
    // point.
    const handler = buildUiStaticHandler();
    const asset = await handler("/", true);
    expect(asset).toBeDefined();
    expect(asset!.contentType).toContain("text/html");
  });

  it("returns undefined (not a fallback page) for an unknown static asset path", async () => {
    const handler = buildUiStaticHandler();
    const asset = await handler("/does-not-exist.js", true);
    expect(asset).toBeUndefined();
  });
});
