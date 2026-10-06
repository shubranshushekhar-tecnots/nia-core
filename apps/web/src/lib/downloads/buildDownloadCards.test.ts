import { describe, expect, it } from "vitest";
import { buildDownloadCards } from "./buildDownloadCards";
import type { DownloadManifestFile } from "./manifest";

const FILES: DownloadManifestFile[] = [
  { name: "NiaCoreAgent-Setup-0.0.1.exe", os: "windows", kind: "primary", size: 29_600_000, sha256: "a".repeat(64) },
  { name: "nia-agent-windows-0.0.1.zip", os: "windows", kind: "advanced", size: 42_900_000, sha256: "b".repeat(64) },
  { name: "nia-agent-macos-arm64-0.0.1.zip", os: "macos", kind: "primary", size: 37_400_000, sha256: "c".repeat(64) },
  { name: "nia-agent-linux-0.0.1.tar.gz", os: "linux", kind: "primary", size: 13_300_000, sha256: "d".repeat(64) },
];

describe("buildDownloadCards", () => {
  it("lists the three packages with the size and checksum from the manifest", () => {
    const cards = buildDownloadCards(FILES);

    expect(cards.map((c) => c.os)).toEqual(["windows", "macos", "linux"]);

    const windows = cards.find((c) => c.os === "windows")!;
    expect(windows.primary.size).toBe(29_600_000);
    expect(windows.primary.sha256).toBe("a".repeat(64));
    expect(windows.advanced?.size).toBe(42_900_000);
    expect(windows.advanced?.sha256).toBe("b".repeat(64));

    const macos = cards.find((c) => c.os === "macos")!;
    expect(macos.primary.size).toBe(37_400_000);
    expect(macos.primary.sha256).toBe("c".repeat(64));
    expect(macos.advanced).toBeUndefined();

    const linux = cards.find((c) => c.os === "linux")!;
    expect(linux.primary.size).toBe(13_300_000);
    expect(linux.primary.sha256).toBe("d".repeat(64));
  });

  it("omits an OS with no primary package instead of throwing", () => {
    const cards = buildDownloadCards(FILES.filter((f) => f.os !== "linux"));
    expect(cards.map((c) => c.os)).toEqual(["windows", "macos"]);
  });
});
