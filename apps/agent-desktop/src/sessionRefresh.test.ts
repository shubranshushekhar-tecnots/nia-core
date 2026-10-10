import { describe, expect, it } from "vitest";
import { NO_SESSION_MARKER, isNoSessionPage, shouldProactivelyRemint } from "./sessionRefresh.js";
import { PROACTIVE_REMINT_INTERVAL_MS } from "./constants.js";

describe("isNoSessionPage", () => {
  it("is true when the body text contains the stable no-session marker", () => {
    expect(isNoSessionPage(`<p>${NO_SESSION_MARKER}</p>`)).toBe(true);
    expect(isNoSessionPage(NO_SESSION_MARKER)).toBe(true);
  });

  it("is false for the real agent UI's content", () => {
    expect(isNoSessionPage("Nia Agent -- Workflows")).toBe(false);
    expect(isNoSessionPage("")).toBe(false);
  });
});

describe("shouldProactivelyRemint", () => {
  it("is true when there has never been a mint yet", () => {
    expect(shouldProactivelyRemint(null, Date.now())).toBe(true);
  });

  it("is false when the last mint is under the proactive-remint interval old", () => {
    const now = 1_000_000_000_000;
    expect(shouldProactivelyRemint(now - PROACTIVE_REMINT_INTERVAL_MS + 1, now)).toBe(false);
  });

  it("is true once the last mint is exactly or older than the proactive-remint interval", () => {
    const now = 1_000_000_000_000;
    expect(shouldProactivelyRemint(now - PROACTIVE_REMINT_INTERVAL_MS, now)).toBe(true);
    expect(shouldProactivelyRemint(now - PROACTIVE_REMINT_INTERVAL_MS - 1, now)).toBe(true);
  });
});
