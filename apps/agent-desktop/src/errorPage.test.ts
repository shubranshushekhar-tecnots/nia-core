import { describe, expect, it } from "vitest";
import { buildServiceNotRunningDataUrl, buildServiceNotRunningHtml } from "./errorPage.js";
import { RETRY_MARKER_URL } from "./constants.js";

describe("buildServiceNotRunningHtml", () => {
  it("contains the plain-words explanation and a Retry link to the internal marker URL", () => {
    const html = buildServiceNotRunningHtml();
    expect(html).toContain("Nia Agent service isn't running");
    expect(html).toContain(`href="${RETRY_MARKER_URL}"`);
  });

  it("includes an auto-retry timer that also navigates to the marker URL", () => {
    const html = buildServiceNotRunningHtml();
    expect(html).toContain(JSON.stringify(RETRY_MARKER_URL));
    expect(html).toContain("setTimeout");
  });

  it("contains no technical jargon like error codes or stack traces", () => {
    const html = buildServiceNotRunningHtml();
    expect(html).not.toMatch(/ECONNREFUSED|stack|Error:/i);
  });
});

describe("buildServiceNotRunningDataUrl", () => {
  it("produces a valid data: URL wrapping the HTML", () => {
    const url = buildServiceNotRunningDataUrl();
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(buildServiceNotRunningHtml());
  });
});
