import { describe, expect, it } from "vitest";
import { resolveProxyUrl } from "./network.js";

describe("resolveProxyUrl", () => {
  it("returns the https proxy for an https target", () => {
    expect(resolveProxyUrl("https://planometry.example.com", { HTTPS_PROXY: "http://proxy:8080" })).toBe("http://proxy:8080");
  });

  it("returns the http proxy for an http target", () => {
    expect(resolveProxyUrl("http://planometry.example.com", { HTTP_PROXY: "http://proxy:8080" })).toBe("http://proxy:8080");
  });

  it("returns undefined when no proxy env is set", () => {
    expect(resolveProxyUrl("https://planometry.example.com", {})).toBeUndefined();
  });

  it("bypasses the proxy for a host matching NO_PROXY", () => {
    expect(
      resolveProxyUrl("https://internal.gms.local", { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "gms.local" }),
    ).toBeUndefined();
  });

  it("bypasses the proxy for a host matching NO_PROXY with a leading dot", () => {
    expect(
      resolveProxyUrl("https://internal.gms.local", { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: ".gms.local" }),
    ).toBeUndefined();
  });

  it("does not bypass for an unrelated NO_PROXY entry", () => {
    expect(
      resolveProxyUrl("https://planometry.example.com", { HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "gms.local" }),
    ).toBe("http://proxy:8080");
  });

  it("supports lowercase env var names", () => {
    expect(resolveProxyUrl("https://planometry.example.com", { https_proxy: "http://proxy:8080" })).toBe("http://proxy:8080");
  });
});
