#!/usr/bin/env node
// Writes apps/agent/packaging/manifest.json after all three platform builds
// have run. Each entry carries exactly what the public downloads page and
// the dev-only download route (apps/web/src/app/api/agent-downloads/[file]/
// route.ts) need: file name, OS, byte size, and a SHA-256 checksum computed
// straight off the built artifact (not hand-copied from a build log). The
// dev download route trusts a request path only if the file name is listed
// here — this manifest IS the allow-list, not just display metadata.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(__dirname, "..", "package.json"), "utf8"),
  ),
);
const version = packageJson.version;

// One entry per shipped artifact. `kind: "advanced"` marks downloads kept
// off the primary three-button choice (the Windows portable zip) per the
// download page's spec — "advanced" downloads still appear in the manifest
// and are servable, just not in the headline Windows/macOS/Linux row.
const candidates = [
  {
    name: `NiaCoreAgent-Setup-${version}.exe`,
    os: "windows",
    kind: "primary",
    dir: path.join(__dirname, "windows", "dist"),
  },
  {
    name: `nia-agent-windows-${version}.zip`,
    os: "windows",
    kind: "advanced",
    dir: path.join(__dirname, "windows", "dist"),
  },
  {
    name: `nia-agent-macos-arm64-${version}.zip`,
    os: "macos",
    kind: "primary",
    dir: path.join(__dirname, "macos", "dist"),
  },
  {
    name: `nia-agent-linux-${version}.tar.gz`,
    os: "linux",
    kind: "primary",
    dir: path.join(__dirname, "linux", "dist"),
  },
];

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const files = [];
for (const candidate of candidates) {
  const filePath = path.join(candidate.dir, candidate.name);
  try {
    const stats = await stat(filePath);
    files.push({
      name: candidate.name,
      os: candidate.os,
      kind: candidate.kind,
      size: stats.size,
      sha256: await sha256(filePath),
    });
  } catch {
    console.warn(`skip (not built yet): ${candidate.name}`);
  }
}

if (files.length === 0) {
  console.error("No built packages found — run each platform's build script first.");
  process.exit(1);
}

const manifest = { version, generatedAt: new Date().toISOString(), files };
const outPath = path.join(__dirname, "manifest.json");
await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${outPath}`);
for (const f of files) console.log(`  ${f.os}/${f.name} size=${f.size} sha256=${f.sha256}`);
