import path from "node:path";
import { describe, expect, it } from "vitest";
import { DownloadNotAllowedError, resolveAgentFilePath, resolveManifestFile } from "./resolveDownload";
import type { DownloadManifest } from "./manifest";

const MANIFEST: DownloadManifest = {
  version: "0.0.1",
  generatedAt: "2026-10-06T00:00:00.000Z",
  files: [
    { name: "NiaCoreAgent-Setup-0.0.1.exe", os: "windows", kind: "primary", size: 123, sha256: "a".repeat(64) },
  ],
};

describe("resolveManifestFile", () => {
  it("resolves a file name that is listed in the manifest", () => {
    const entry = resolveManifestFile(MANIFEST, "NiaCoreAgent-Setup-0.0.1.exe");
    expect(entry.os).toBe("windows");
  });

  it("refuses a file name that is not in the manifest", () => {
    expect(() => resolveManifestFile(MANIFEST, "not-a-real-file.exe")).toThrow(DownloadNotAllowedError);
  });

  it("refuses a path that tries to leave the folder", () => {
    expect(() => resolveManifestFile(MANIFEST, "../../../etc/passwd")).toThrow(DownloadNotAllowedError);
    expect(() => resolveManifestFile(MANIFEST, "..%2f..%2fetc%2fpasswd")).toThrow(DownloadNotAllowedError);
    expect(() => resolveManifestFile(MANIFEST, "windows/NiaCoreAgent-Setup-0.0.1.exe")).toThrow(
      DownloadNotAllowedError,
    );
    expect(() => resolveManifestFile(MANIFEST, "..\\NiaCoreAgent-Setup-0.0.1.exe")).toThrow(
      DownloadNotAllowedError,
    );
    expect(() => resolveManifestFile(MANIFEST, "")).toThrow(DownloadNotAllowedError);
  });
});

describe("resolveAgentFilePath", () => {
  it("resolves a manifest entry to a path inside its OS dist dir", () => {
    const entry = resolveManifestFile(MANIFEST, "NiaCoreAgent-Setup-0.0.1.exe");
    const resolved = resolveAgentFilePath(entry);
    const expectedSuffix = path.join("windows", "dist", "NiaCoreAgent-Setup-0.0.1.exe");
    expect(resolved.endsWith(expectedSuffix)).toBe(true);
  });
});
