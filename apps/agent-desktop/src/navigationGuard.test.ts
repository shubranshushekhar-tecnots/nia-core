import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigationGuard.js";

describe("isAllowedNavigation", () => {
  const port = 57415;

  it("allows the agent's own origin, any path", () => {
    expect(isAllowedNavigation("http://127.0.0.1:57415/", port)).toBe(true);
    expect(isAllowedNavigation("http://127.0.0.1:57415/connections", port)).toBe(true);
    expect(isAllowedNavigation("http://127.0.0.1:57415/?otc=abc", port)).toBe(true);
  });

  it("denies a different port", () => {
    expect(isAllowedNavigation("http://127.0.0.1:9999/", port)).toBe(false);
  });

  it("denies a different host", () => {
    expect(isAllowedNavigation("http://localhost:57415/", port)).toBe(false);
    expect(isAllowedNavigation("http://evil.example.com:57415/", port)).toBe(false);
  });

  it("denies https even to the right host/port", () => {
    expect(isAllowedNavigation("https://127.0.0.1:57415/", port)).toBe(false);
  });

  it("denies external https links", () => {
    expect(isAllowedNavigation("https://nia.dev/docs", port)).toBe(false);
  });

  it("denies javascript: and file: URLs", () => {
    expect(isAllowedNavigation("javascript:alert(1)", port)).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd", port)).toBe(false);
  });

  it("denies malformed URLs without throwing", () => {
    expect(isAllowedNavigation("not a url", port)).toBe(false);
  });
});
