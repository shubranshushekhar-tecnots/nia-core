#!/usr/bin/env node
// Assembles the full macOS install bundle: the agent SEA executable (built
// by build-sea.mjs), the launchd plist template, and install/uninstall
// shell scripts — zipped into one file. No downloads happen here;
// build-sea.mjs already fetched and verified everything it needed.
//
// Usage (from repo root, after `pnpm -r --filter @nia/extract --filter
// @nia/agent build`):
//   node apps/agent/packaging/macos/build-sea.mjs
//   node apps/agent/packaging/macos/build-bundle.mjs
//
// Produces apps/agent/packaging/macos/dist/nia-agent-macos-arm64-<version>.zip
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "../../");
const distDir = path.join(here, "dist");

async function main() {
  const version = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8")).version;
  const seaExePath = path.join(distDir, "nia-agent");
  if (!existsSync(seaExePath)) {
    throw new Error(`${seaExePath} not found — run build-sea.mjs first`);
  }

  const stageDir = path.join(distDir, "stage");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  console.log("[1/2] staging agent executable, plist template, and scripts...");
  copyFileSync(seaExePath, path.join(stageDir, "nia-agent"));
  chmodSync(path.join(stageDir, "nia-agent"), 0o755);
  copyFileSync(path.join(here, "nia-agent.plist.template"), path.join(stageDir, "nia-agent.plist.template"));
  copyFileSync(path.join(here, "install.sh"), path.join(stageDir, "install.sh"));
  copyFileSync(path.join(here, "uninstall.sh"), path.join(stageDir, "uninstall.sh"));
  chmodSync(path.join(stageDir, "install.sh"), 0o755);
  chmodSync(path.join(stageDir, "uninstall.sh"), 0o755);
  writeFileSync(path.join(stageDir, "VERSION.txt"), `Nia Core Agent ${version} (darwin-arm64)\nBuilt ${new Date().toISOString()}\n`);

  console.log("[2/2] zipping bundle...");
  const zipName = `nia-agent-macos-arm64-${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  rmSync(zipPath, { force: true });
  // -y preserves symlinks (none here) and, more importantly, file modes
  // (the exec bits on nia-agent/install.sh/uninstall.sh) so unzip on the
  // target machine restores them without a separate chmod step.
  execFileSync("zip", ["-r", "-q", "-y", zipPath, "."], { cwd: stageDir });
  rmSync(stageDir, { recursive: true, force: true });

  console.log(`\nbuilt ${zipPath}`);
  console.log(`sha256: ${sha256File(zipPath)}`);
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
